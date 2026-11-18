/**
 * App de votación interna.
 * - Lista cerrada de votantes identificados por correo.
 * - Cada votante recibe un enlace personal de un solo uso.
 * - El voto se guarda sin vínculo con el votante (voto secreto).
 *
 * Variables de entorno: DATABASE_URL y ADMIN_PASSWORD (obligatorias).
 * El envío de correo se configura desde el panel /admin.
 */
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const { DATABASE_URL, ADMIN_PASSWORD } = process.env;
// Render inyecta RENDER_EXTERNAL_URL automáticamente; BASE_URL solo se usa
// si quieres forzar otro valor (por ejemplo un dominio propio).
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`)
  .replace(/\/+$/, '');
// Punto final de la API de Brevo. Se puede sobrescribir para pruebas.
const BREVO_URL = process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email';

if (!DATABASE_URL || !ADMIN_PASSWORD) {
  console.error('ERROR: faltan las variables DATABASE_URL y/o ADMIN_PASSWORD.');
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

// ---------------------------------------------------------------- utilidades
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Extrae nombre y correo de una lista pegada desde Excel, Word o un correo.
 *  Acepta "Ana Restrepo, ana@x.com", "Ana Restrepo <ana@x.com>", una columna
 *  de correos sueltos, o varios correos en la misma línea. */
function parseVoters(text) {
  const out = []; const seen = new Set(); let duplicates = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const found = line.match(EMAIL_RE) || [];
    if (!found.length) continue;
    // El nombre solo tiene sentido cuando la línea trae un único correo.
    let name = '';
    if (found.length === 1) {
      name = line.replace(found[0], ' ')
        .replace(/[<>"']/g, ' ')
        .replace(/[,;\t|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-–—:.]+|[-–—:.]+$/g, '')
        .trim()
        .slice(0, 120);
    }
    for (const raw of found) {
      const email = raw.toLowerCase();
      if (seen.has(email)) { duplicates++; continue; }
      seen.add(email);
      out.push({ name, email });
    }
  }
  return { voters: out, duplicates };
}

// ---------------------------------------------------------- base de datos
async function init() {
  await pool.query(`
    create table if not exists settings(
      key text primary key,
      value text not null default '');
    create table if not exists election(
      id int primary key default 1 check (id = 1),
      title text not null default '',
      description text not null default '',
      status text not null default 'draft');
    create table if not exists questions(
      id serial primary key,
      title text not null,
      position int not null,
      pick int not null default 1);
    create table if not exists options(
      id serial primary key,
      label text not null,
      position int not null);
    create table if not exists voters(
      id serial primary key,
      email text unique not null,
      name text not null default '',
      token_hash text,
      last_sent timestamptz,
      invited_at timestamptz,
      voted boolean not null default false);
    create table if not exists votes(
      id serial primary key,
      option_id int not null references options(id) on delete cascade);
    insert into election(id) values (1) on conflict do nothing;
  `);
  // Compatibilidad con bases creadas por versiones anteriores.
  await pool.query(`alter table voters add column if not exists invited_at timestamptz`);
  await pool.query(`alter table voters add column if not exists name text not null default ''`);
  await pool.query(`alter table options add column if not exists question_id int
                    references questions(id) on delete cascade`);
  // pick = cuántas opciones debe marcar el votante en esa pregunta.
  await pool.query(`alter table questions add column if not exists pick int not null default 1`);
  // Si quedaron opciones de cuando solo había una pregunta, se agrupan bajo
  // una pregunta hecha con el título de la votación.
  const { rows: [{ n }] } = await pool.query(
    'select count(*)::int as n from options where question_id is null');
  if (n > 0) {
    const { rows: [el] } = await pool.query('select title from election where id = 1');
    const { rows: [q] } = await pool.query(
      'insert into questions(title, position) values ($1, 0) returning id', [el.title || 'Pregunta']);
    await pool.query('update options set question_id = $1 where question_id is null', [q.id]);
  }
}

/** Devuelve las preguntas con sus opciones, en orden. */
async function getQuestions() {
  const { rows } = await pool.query(`
    select q.id as qid, q.title, q.pick, o.id as oid, o.label
    from questions q left join options o on o.question_id = q.id
    order by q.position, o.position`);
  const out = [];
  for (const r of rows) {
    let q = out.find((x) => x.id === r.qid);
    if (!q) { q = { id: r.qid, title: r.title, pick: r.pick, options: [] }; out.push(q); }
    if (r.oid) q.options.push({ id: r.oid, label: r.label });
  }
  return out;
}

const getSettings = async () => {
  const { rows } = await pool.query('select key, value from settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};
const setSettings = async (obj) => {
  for (const [k, v] of Object.entries(obj))
    await pool.query(
      `insert into settings(key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`, [k, String(v ?? '')]);
};
const getElection = async () => {
  const { rows: [el] } = await pool.query('select title, description, status from election where id = 1');
  return el;
};
/** Conteo agrupado por pregunta. */
const tally = async () => {
  const { rows } = await pool.query(`
    select q.id as qid, q.title, q.pick, o.label, count(v.id)::int as votes
    from questions q
    join options o on o.question_id = q.id
    left join votes v on v.option_id = o.id
    group by q.id, q.title, q.pick, q.position, o.id, o.label, o.position
    order by q.position, o.position`);
  const out = [];
  for (const r of rows) {
    let q = out.find((x) => x.id === r.qid);
    if (!q) { q = { id: r.qid, title: r.title, pick: r.pick, results: [] }; out.push(q); }
    q.results.push({ label: r.label, votes: r.votes });
  }
  // Con pick > 1 cada papeleta deja varias marcas, así que el número de
  // papeletas es lo que sirve de referencia para los porcentajes.
  for (const q of out) {
    const marks = q.results.reduce((a, r) => a + r.votes, 0);
    q.ballots = q.pick > 0 ? Math.round(marks / q.pick) : 0;
  }
  return out;
};

// ------------------------------------------------------------------- correo
/** Envía un correo. `adjuntos` = [{ name, content }] con el contenido en base64.
 *  Lanza un Error con mensaje legible si falla. */
async function sendMail(to, subject, html, text, adjuntos) {
  const s = await getSettings();
  const fromEmail = s.from_email || '';
  const fromName = s.from_name || 'Votación';

  if (s.provider === 'brevo') {
    if (!s.brevo_key) throw new Error('Falta la clave de API de Brevo.');
    if (!fromEmail) throw new Error('Falta el correo del remitente.');
    const r = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': s.brevo_key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: to }],
        subject, htmlContent: html, textContent: text,
        ...(adjuntos && adjuntos.length ? { attachment: adjuntos } : {}),
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      let msg = body.slice(0, 300);
      try { const j = JSON.parse(body); msg = j.message || msg; } catch {}
      if (r.status === 401) msg = 'Clave de API rechazada por Brevo. Revisa que la copiaste completa.';
      if (/sender/i.test(msg)) msg = `Brevo no acepta el remitente "${fromEmail}". Verifícalo en Brevo: Settings → Senders.`;
      throw new Error(`Brevo respondió ${r.status}: ${msg}`);
    }
    return;
  }

  if (s.provider === 'smtp') {
    if (!s.smtp_host) throw new Error('Falta el servidor SMTP.');
    const port = +(s.smtp_port || 587);
    const t = nodemailer.createTransport({
      host: s.smtp_host, port, secure: port === 465,
      auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
      connectionTimeout: 20000, greetingTimeout: 20000,
    });
    try {
      await t.sendMail({
        from: `"${fromName}" <${fromEmail || s.smtp_user}>`, to, subject, html, text,
        attachments: (adjuntos || []).map((a) => ({
          filename: a.name, content: Buffer.from(a.content, 'base64'),
        })),
      });
    } catch (e) {
      if (/ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i.test(e.code || e.message))
        throw new Error('No se pudo conectar al servidor SMTP. Si estás en el plan gratuito de Render, '
          + 'los puertos SMTP están bloqueados: usa la opción Brevo.');
      throw new Error(e.message);
    } finally { t.close(); }
    return;
  }

  // Modo prueba: no envía nada, solo registra en la consola del servidor.
  console.log(`[MODO PRUEBA] Para: ${to} | ${subject}`
    + (adjuntos && adjuntos.length ? ` | adjuntos: ${adjuntos.map((a) => a.name).join(', ')}` : '')
    + `\n${text}`);
}

// ------------------------------------------------- acta de quórum
const ZONA = 'America/Bogota'; // Para las fechas del acta.
// 24 horas: evita el "p. m." que deja dos puntos al cerrar la frase.
const fechaLarga = (d) => d.toLocaleString('es-CO',
  { timeZone: ZONA, dateStyle: 'long', timeStyle: 'short', hour12: false });

/** Escapa un valor para CSV. */
const csvVal = (v) => (/[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csvDoc = (filas) => '﻿' + filas.map((f) => f.map(csvVal).join(',')).join('\r\n');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** Envía al organizador el acta de participación, con los CSV adjuntos. */
async function sendQuorum() {
  const s = await getSettings();
  const destino = (s.organizer_email || s.from_email || '').trim();
  if (!destino) {
    await setSettings({ quorum_error: 'No hay correo del organizador configurado.' });
    return;
  }
  const el = await getElection();
  const { rows: voters } = await pool.query(
    `select name, email, voted, invited_at is not null as invited
     from voters order by voted desc, name, email`);
  const questions = await tally();
  const votaron = voters.filter((v) => v.voted).length;
  const pct = voters.length ? Math.round(votaron * 1000 / voters.length) / 10 : 0;
  const ahora = new Date();
  const dia = ahora.toLocaleDateString('en-CA', { timeZone: ZONA }); // AAAA-MM-DD

  const quorum = csvDoc([
    ['nombre', 'correo', 'voto', 'invitado'],
    ...voters.map((v) => [v.name, v.email, v.voted ? 'sí' : 'no', v.invited ? 'sí' : 'no']),
  ]);
  const resultados = csvDoc([
    ['pregunta', 'opcion', 'votos', 'porcentaje'],
    ...questions.flatMap((q) => {
      const marcas = q.results.reduce((a, r) => a + r.votes, 0);
      const base = q.pick > 1 ? q.ballots : marcas;
      return q.results.map((r) => [q.title, r.label, r.votes,
        (base ? Math.round(r.votes * 1000 / base) / 10 : 0) + '%']);
    }),
  ]);

  const filas = questions.map((q) => {
    const lista = q.results.map((r) => `${esc(r.label)}: ${r.votes}`).join(' · ');
    return `<tr><td style="padding:4px 0"><b>${esc(q.title)}</b><br>
      <span style="color:#667085">${lista}</span></td></tr>`;
  }).join('');

  const text = [
    `Acta de participación: ${el.title}`, '',
    `Votación cerrada el ${fechaLarga(ahora)}.`,
    `Participación: ${votaron} de ${voters.length} votantes (${pct}%).`, '',
    'Adjuntos:',
    `  - quorum-${dia}.csv: quién votó y quién no.`,
    `  - resultados-${dia}.csv: el recuento de cada pregunta.`, '',
    'El acta registra quién votó, pero no qué votó: esos datos se guardan por',
    'separado y no hay forma de relacionarlos.',
  ].join('\n');

  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:16px;
      line-height:1.6;color:#1c2230;max-width:560px">
    <p style="font-size:19px;font-weight:700;margin:0 0 4px">Acta de participación</p>
    <p style="margin:0 0 18px;color:#667085">${esc(el.title)}</p>
    <p style="margin:0 0 6px">Votación cerrada el <b>${esc(fechaLarga(ahora))}</b>.</p>
    <p style="margin:0 0 18px">Participación:
      <b>${votaron} de ${voters.length}</b> votantes (${pct}%).</p>
    <table style="width:100%;border-collapse:collapse">${filas}</table>
    <p style="margin-top:22px">Adjuntos: la lista de quién votó y el recuento por pregunta,
      en dos archivos CSV que puedes abrir en Excel.</p>
    <p style="font-size:13px;color:#667085">El acta registra quién votó, pero no qué votó:
      esos datos se guardan por separado y no hay forma de relacionarlos.</p>
  </div>`;

  try {
    await sendMail(destino, `Acta de participación: ${el.title}`, html, text, [
      { name: `quorum-${dia}.csv`, content: b64(quorum) },
      { name: `resultados-${dia}.csv`, content: b64(resultados) },
    ]);
    await setSettings({ quorum_sent_at: ahora.toISOString(), quorum_error: '', quorum_to: destino });
  } catch (e) {
    console.error('Fallo al enviar el acta:', e.message);
    await setSettings({ quorum_error: e.message });
  }
}

// ----------------------------------------- mensaje de invitación editable
// El texto se guarda en el panel. Admite {NOMBRE}, enlaces [texto](url) y la
// línea [ Votar ahora ], que se convierte en el botón con el enlace personal.
const BOTON = '[ Votar ahora ]';
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const A = 'style="color:#2f5bea"';

const ASUNTO_POR_DEFECTO = 'Elección de la Junta Directiva de la COLEVOL: tu enlace para votar';
const MENSAJE_POR_DEFECTO = `Hola, {NOMBRE}:

La Asociación Colombiana de Biología Evolutiva - COLEVOL está renovando su Junta Directiva y, como miembro, tienes derecho a voto.

Se eligen siete cargos: Presidencia, Secretaría, Tesorería y cuatro Vocalías. Podrás responder todo en pocos minutos. [Puedes ver información de las candidatas y los candidatos aquí](https://drive.google.com/file/d/1AWfEQ5Gr6rsg46QlJQyAqMox40x-4nad/view?usp=drive_link)

${BOTON}

El enlace de arriba es personal y funciona una sola vez, así que te pedimos no compartirlo con nadie.

Tu voto es importante, necesitamos alcanzar el quórum de votación para validar la nueva junta. Tienes plazo hasta el 18 de diciembre.

Además, tu voto es secreto: el sistema registra que votaste, para efectos de quórum, pero no guarda ningún vínculo entre tu nombre y las opciones que elijas. La plataforma se publica en Render y envía los correos con Brevo; su código está disponible para quien quiera revisarlo en https://github.com/gsilvaarias/votacion

Gracias por participar en la vida de COLEVOL.

Junta Directiva
Asociación Colombiana de Biología Evolutiva`;

/** Quita {NOMBRE} y la coma que lo precede cuando el votante no tiene nombre. */
const ponNombre = (s, name) => (name
  ? s.replace(/\{NOMBRE\}/g, name)
  : s.replace(/,?[ \t]*\{NOMBRE\}/g, ''));

function inlineHtml(s) {
  const guardados = [];
  let out = esc(s).replace(LINK_RE, (m, t, u) => {
    guardados.push(`<a href="${u}" ${A}>${t}</a>`);
    return `\u0000${guardados.length - 1}\u0000`;
  });
  // Direcciones escritas sueltas también se vuelven enlace.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, pre, u) => `${pre}<a href="${u}" ${A}>${u}</a>`);
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => guardados[+i]).replace(/\n/g, '<br>');
}
const inlineText = (s) => s.replace(LINK_RE, (m, t, u) => `${t}: ${u}`);

/** Arma el correo de invitación de un votante concreto. */
function inviteBody(body, name, link) {
  const parrafos = ponNombre(String(body || ''), name)
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const boton = `<p style="margin:26px 0"><a href="${esc(link)}"
      style="background:#2f5bea;color:#fff;padding:13px 26px;border-radius:8px;
      text-decoration:none;font-weight:600;display:inline-block">Votar ahora</a></p>`;
  const botonTexto = `Para votar, abre este enlace:\n${link}`;

  let html = '', text = '', puesto = false;
  for (const p of parrafos) {
    if (p === BOTON) {
      puesto = true;
      html += boton;
      text += botonTexto + '\n\n';
    } else {
      html += `<p style="margin:0 0 14px">${inlineHtml(p)}</p>`;
      text += inlineText(p) + '\n\n';
    }
  }
  // Por si alguien borra la marca del botón: el correo nunca sale sin enlace.
  if (!puesto) { html += boton; text += botonTexto + '\n\n'; }

  html += `<p style="font-size:13px;color:#667085;margin-top:22px">
    Si el botón no funciona, copia esta dirección en tu navegador:<br>
    <span style="word-break:break-all">${esc(link)}</span></p>`;
  return {
    text: text.trim(),
    html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:16px;
      line-height:1.6;color:#1c2230;max-width:560px">${html}</div>`,
  };
}

/** Correo con los resultados, que se manda a todos los votantes al cerrar. */
function resultsBody(el, questions, voted, totalVoters) {
  const lines = [`Resultados de: ${el.title}`, '',
    `Participación: ${voted} de ${totalVoters} votantes.`, ''];
  let rows = '';
  for (const q of questions) {
    const marks = q.results.reduce((a, r) => a + r.votes, 0);
    const base = q.pick > 1 ? q.ballots : marks;
    const pct = (n) => (base ? Math.round(n * 1000 / base) / 10 : 0);
    const nota = q.pick > 1
      ? (q.ballots === 1
        ? `1 papeleta con ${q.pick} marcas`
        : `${q.ballots} papeletas, cada una con ${q.pick} marcas`)
      : `${marks} ${marks === 1 ? 'voto' : 'votos'}`;

    lines.push(q.title, `(${nota})`);
    for (const r of q.results) lines.push(`  - ${r.label}: ${r.votes} (${pct(r.votes)}%)`);
    lines.push('');

    rows += `<tr><td colspan="3" style="padding:22px 0 2px;font-size:17px;font-weight:700">
      ${esc(q.title)}</td></tr>
      <tr><td colspan="3" style="padding:0 0 8px;color:#667085;font-size:13px">${esc(nota)}</td></tr>`;
    for (const r of q.results) {
      const w = base ? Math.round(r.votes * 100 / base) : 0;
      rows += `<tr>
        <td style="padding:5px 12px 5px 0;font-size:15px">${esc(r.label)}</td>
        <td style="padding:5px 12px 5px 0;font-size:15px;white-space:nowrap;color:#667085">
          ${r.votes} · ${pct(r.votes)}%</td>
        <td style="width:150px;padding:5px 0">
          <div style="background:#e9edf4;border-radius:5px;height:10px">
            <div style="background:#2f5bea;border-radius:5px;height:10px;width:${w}%"></div>
          </div></td></tr>`;
    }
  }
  lines.push(`Puedes consultarlos también en: ${BASE_URL}`);
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#1c2230;max-width:560px">
    <p style="font-size:19px;font-weight:700;margin:0 0 4px">${esc(el.title)}</p>
    <p style="color:#667085;margin:0 0 18px">La votación ha terminado. Estos son los resultados.</p>
    <p style="margin:0 0 6px">Participación: <b>${voted} de ${totalVoters}</b> votantes.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="margin-top:26px;font-size:13px;color:#667085">
      También puedes consultarlos en <a href="${esc(BASE_URL)}">${esc(BASE_URL)}</a>.</p>
  </div>`;
  return { subject: `Resultados: ${el.title}`, text: lines.join('\n'), html };
}

/** Genera un token nuevo para un votante y devuelve su enlace personal. */
async function issueLink(voterId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('update voters set token_hash = $1, last_sent = now() where id = $2', [sha(token), voterId]);
  return `${BASE_URL}/?t=${token}`;
}

// ------------------------------------------------- trabajo de envío masivo
let job = { running: false, kind: '', total: 0, sent: 0, failed: [], finishedAt: null };

async function runInvitations(onlyPending) {
  if (job.running) return;
  const { rows: voters } = await pool.query(
    `select id, email, name from voters
     where voted = false ${onlyPending ? 'and invited_at is null' : ''}
     order by id`);
  job = { running: true, kind: 'invitaciones', total: voters.length, sent: 0, failed: [], finishedAt: null };
  const s = await getSettings();
  const asunto = s.invite_subject || ASUNTO_POR_DEFECTO;
  const cuerpo = s.invite_body || MENSAJE_POR_DEFECTO;
  for (const v of voters) {
    try {
      const link = await issueLink(v.id);
      const { text, html } = inviteBody(cuerpo, v.name, link);
      await sendMail(v.email, ponNombre(asunto, v.name), html, text);
      await pool.query('update voters set invited_at = now() where id = $1', [v.id]);
      job.sent++;
    } catch (e) {
      job.failed.push({ email: v.email, error: e.message });
    }
    await sleep(300); // Respeta el límite de 300 peticiones/minuto de Brevo.
  }
  job.running = false;
  job.finishedAt = new Date().toISOString();
}

/** Manda los resultados a TODOS los votantes, hayan votado o no. */
async function runResults() {
  if (job.running) return;
  const { rows: voters } = await pool.query('select email from voters order by id');
  job = { running: true, kind: 'resultados', total: voters.length, sent: 0, failed: [], finishedAt: null };
  const el = await getElection();
  const questions = await tally();
  const { rows: [c] } = await pool.query(
    `select count(*) filter (where voted)::int as voted, count(*)::int as total from voters`);
  const { subject, text, html } = resultsBody(el, questions, c.voted, c.total);
  for (const v of voters) {
    try {
      await sendMail(v.email, subject, html, text);
      job.sent++;
    } catch (e) {
      job.failed.push({ email: v.email, error: e.message });
    }
    await sleep(300);
  }
  job.running = false;
  job.finishedAt = new Date().toISOString();
  await setSettings({ results_sent_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- servidor
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Límite de peticiones por IP. Generoso a propósito: en una asamblea todos
// los votantes pueden compartir la misma IP (una sola red wifi).
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = `${req.ip}|${req.path}`, now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'Demasiadas peticiones. Espera unos minutos.' });
  arr.push(now); hits.set(key, arr); next();
};
setInterval(() => hits.clear(), 3600_000).unref();

app.get('/health', (_req, res) => res.type('text').send('ok'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ------------------------------------------------------------------ público
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/election', async (_req, res) => {
  const el = await getElection();
  const out = { title: el.title, description: el.description, status: el.status };
  if (el.status === 'closed') out.results = await tally();
  res.json(out);
});

app.post('/api/request-link', limit(400, 3600_000), async (req, res) => {
  // Respuesta siempre igual: no revela si un correo está registrado.
  const generic = { ok: true, message: 'Si tu correo está en la lista de votantes, recibirás un enlace en unos minutos. Revisa también la carpeta de correo no deseado.' };
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(generic);

  const el = await getElection();
  if (el.status !== 'open') return res.status(409).json({ error: 'La votación no está abierta en este momento.' });

  const { rows: [voter] } = await pool.query(
    'select id, voted, last_sent, name from voters where email = $1', [email]);
  if (!voter || voter.voted) return res.json(generic);
  if (voter.last_sent && Date.now() - new Date(voter.last_sent) < 60_000) return res.json(generic);

  try {
    const link = await issueLink(voter.id);
    const s = await getSettings();
    const { text, html } = inviteBody(s.invite_body || MENSAJE_POR_DEFECTO, voter.name, link);
    await sendMail(email, ponNombre(s.invite_subject || ASUNTO_POR_DEFECTO, voter.name), html, text);
    await pool.query('update voters set invited_at = now() where id = $1', [voter.id]);
  } catch (e) {
    console.error('Fallo al enviar enlace a', email, '-', e.message);
  }
  res.json(generic);
});

app.get('/api/ballot', limit(2000, 3600_000), async (req, res) => {
  const el = await getElection();
  const { rows: [voter] } = await pool.query(
    'select id from voters where token_hash = $1 and voted = false', [sha(req.query.t || '')]);
  if (!voter) return res.status(403).json({ error: 'Este enlace no es válido o ya fue utilizado.' });
  if (el.status !== 'open') return res.status(409).json({ error: 'La votación no está abierta en este momento.' });
  res.json({ title: el.title, description: el.description, questions: await getQuestions() });
});

app.post('/api/vote', limit(2000, 3600_000), async (req, res) => {
  const { token, answers } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [el] } = await client.query('select status from election where id = 1');
    if (el.status !== 'open') {
      await client.query('rollback');
      return res.status(409).json({ error: 'La votación no está abierta en este momento.' });
    }

    // Hay que responder a todas las preguntas, y cada opción elegida debe
    // pertenecer a su propia pregunta.
    const { rows: questions } = await client.query(
      'select id, title, pick from questions order by position');
    const chosen = [];
    for (const q of questions) {
      // La respuesta puede venir como un id suelto o como lista de ids.
      const raw = (answers || {})[q.id];
      const ids = [...new Set((Array.isArray(raw) ? raw : [raw])
        .map((x) => +x).filter((x) => Number.isInteger(x) && x > 0))];

      if (ids.length !== q.pick) {
        await client.query('rollback');
        return res.status(400).json({
          error: q.pick === 1
            ? `Falta responder: "${q.title}".`
            : `En "${q.title}" tienes que marcar exactamente ${q.pick} opciones.`,
        });
      }
      // Todas las opciones elegidas deben pertenecer a esa misma pregunta.
      const { rows: valid } = await client.query(
        'select id from options where question_id = $1 and id = any($2::int[])', [q.id, ids]);
      if (valid.length !== ids.length) {
        await client.query('rollback');
        return res.status(400).json({ error: `Hay una opción no válida en "${q.title}".` });
      }
      chosen.push(...valid.map((o) => o.id));
    }
    if (!chosen.length) {
      await client.query('rollback');
      return res.status(400).json({ error: 'La votación no tiene preguntas.' });
    }

    // Marca al votante y anula su token en una sola operación atómica.
    // Si dos peticiones llegan a la vez, solo una afecta una fila.
    const upd = await client.query(
      'update voters set voted = true, token_hash = null where token_hash = $1 and voted = false',
      [sha(token || '')]);
    if (upd.rowCount !== 1) {
      await client.query('rollback');
      return res.status(403).json({ error: 'Este enlace no es válido o ya fue utilizado.' });
    }
    // Los votos se guardan sin ninguna referencia al votante.
    for (const id of chosen) await client.query('insert into votes(option_id) values ($1)', [id]);
    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------------------- admin
function auth(req, res, next) {
  const [, b64] = (req.headers.authorization || '').split(' ');
  const pass = Buffer.from(b64 || '', 'base64').toString('utf8').split(':').slice(1).join(':');
  if (crypto.timingSafeEqual(Buffer.from(sha(pass)), Buffer.from(sha(ADMIN_PASSWORD)))) return next();
  res.set('WWW-Authenticate', 'Basic realm="Panel de administracion"')
    .status(401).type('text').send('Necesitas la contraseña de administración.');
}

app.get('/admin', auth, (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/admin/state', auth, async (_req, res) => {
  const s = await getSettings();
  const { rows: voters } = await pool.query(
    'select email, name, voted, invited_at is not null as invited from voters order by email');
  res.json({
    election: await getElection(),
    results: await tally(),
    questions: await getQuestions(),
    voters,
    baseUrl: BASE_URL,
    resultsSentAt: s.results_sent_at || '',
    quorum: {
      sentAt: s.quorum_sent_at || '',
      to: s.quorum_to || '',
      error: s.quorum_error || '',
    },
    invite: {
      subject: s.invite_subject || ASUNTO_POR_DEFECTO,
      body: s.invite_body || MENSAJE_POR_DEFECTO,
      marker: BOTON,
    },
    mail: {
      provider: s.provider || '',
      from_email: s.from_email || '',
      from_name: s.from_name || '',
      organizer_email: s.organizer_email || '',
      smtp_host: s.smtp_host || '',
      smtp_port: s.smtp_port || '',
      smtp_user: s.smtp_user || '',
      // Nunca se devuelven las claves, solo si existen.
      has_brevo_key: !!s.brevo_key,
      has_smtp_pass: !!s.smtp_pass,
    },
    job,
  });
});

app.post('/api/admin/mail', auth, async (req, res) => {
  const b = req.body || {};
  const out = {};
  // Solo se toca lo que viene en la petición: así guardar un campo
  // nunca borra los demás.
  if (b.provider !== undefined)
    out.provider = ['brevo', 'smtp', 'test'].includes(b.provider) ? b.provider : 'test';
  if (b.from_email !== undefined) out.from_email = String(b.from_email).trim().toLowerCase();
  if (b.organizer_email !== undefined) out.organizer_email = String(b.organizer_email).trim().toLowerCase();
  if (b.from_name !== undefined) out.from_name = String(b.from_name).trim() || 'Votación';
  if (b.smtp_host !== undefined) out.smtp_host = String(b.smtp_host).trim();
  if (b.smtp_port !== undefined) out.smtp_port = String(b.smtp_port).trim();
  if (b.smtp_user !== undefined) out.smtp_user = String(b.smtp_user).trim();
  // Las claves solo se sobrescriben si llega un valor nuevo no vacío.
  if (b.brevo_key) out.brevo_key = String(b.brevo_key).trim();
  if (b.smtp_pass) out.smtp_pass = String(b.smtp_pass);
  await setSettings(out);
  res.json({ ok: true });
});

// Texto del correo de invitación, editable desde el panel.
app.post('/api/admin/invite-text', auth, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!subject) return res.status(400).json({ error: 'El asunto no puede quedar vacío.' });
  if (body.length < 20) return res.status(400).json({ error: 'El mensaje es demasiado corto.' });
  if (!body.includes(BOTON))
    return res.status(400).json({
      error: `Falta la línea ${BOTON} en el mensaje: es donde se coloca el botón para votar.`,
    });
  await setSettings({ invite_subject: subject, invite_body: body });
  res.json({ ok: true });
});

// Vista previa del correo tal y como lo recibiría un votante.
app.post('/api/admin/invite-preview', auth, async (req, res) => {
  const s = await getSettings();
  const body = String(req.body?.body ?? (s.invite_body || MENSAJE_POR_DEFECTO));
  const subject = String(req.body?.subject ?? (s.invite_subject || ASUNTO_POR_DEFECTO));
  const name = String(req.body?.name || '').trim();
  const { html, text } = inviteBody(body, name, `${BASE_URL}/?t=EJEMPLO`);
  res.json({ subject: ponNombre(subject, name), html, text });
});

app.post('/api/admin/mail-test', auth, async (req, res) => {
  const to = String(req.body?.to || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Escribe un correo válido.' });
  try {
    await sendMail(to, 'Prueba de correo - app de votación',
      '<p>Si lees esto, el envío de correos funciona correctamente.</p>',
      'Si lees esto, el envío de correos funciona correctamente.');
    const s = await getSettings();
    res.json({ ok: true, test: s.provider !== 'brevo' && s.provider !== 'smtp' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/setup', auth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const { voters: lista, duplicates } = parseVoters(req.body?.emails);

  // Cada pregunta trae su propio texto y sus opciones, una por línea.
  const questions = (Array.isArray(req.body?.questions) ? req.body.questions : [])
    .map((q) => ({
      title: String(q?.title || '').trim(),
      pick: Math.max(1, Math.min(50, parseInt(q?.pick, 10) || 1)),
      options: String(q?.options || '').split('\n').map((o) => o.replace(/^[-*•]\s*/, '').trim()).filter(Boolean),
    }))
    .filter((q) => q.title || q.options.length);

  if (!title) return res.status(400).json({ error: 'Escribe el nombre de la votación.' });
  if (!questions.length) return res.status(400).json({ error: 'Añade al menos una pregunta.' });
  if (questions.length > 30) return res.status(400).json({ error: 'Máximo 30 preguntas.' });
  for (let i = 0; i < questions.length; i++) {
    const n = questions.length > 1 ? ` (pregunta ${i + 1})` : '';
    if (!questions[i].title) return res.status(400).json({ error: `Falta el texto de la pregunta${n}.` });
    if (questions[i].options.length < 2)
      return res.status(400).json({ error: `Escribe al menos 2 opciones, una por línea${n}.` });
    if (questions[i].options.length > 50)
      return res.status(400).json({ error: `Máximo 50 opciones por pregunta${n}.` });
    if (questions[i].pick > questions[i].options.length)
      return res.status(400).json({
        error: `Pides marcar ${questions[i].pick} opciones pero solo hay `
          + `${questions[i].options.length}${n}.`,
      });
  }
  if (!lista.length) return res.status(400).json({ error: 'No encontré ningún correo válido en la lista de votantes.' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [el] } = await client.query('select status from election where id = 1 for update');
    if (el.status !== 'draft') {
      await client.query('rollback');
      return res.status(409).json({ error: 'La votación ya fue abierta. Para cambiarla debes reiniciarla.' });
    }
    await client.query('delete from votes');
    await client.query('delete from options');
    await client.query('delete from questions');
    await client.query('delete from voters');
    await client.query('update election set title = $1, description = $2 where id = 1', [title, description]);
    let nOptions = 0;
    for (let i = 0; i < questions.length; i++) {
      const { rows: [q] } = await client.query(
        'insert into questions(title, position, pick) values ($1, $2, $3) returning id',
        [questions[i].title, i, questions[i].pick]);
      for (let j = 0; j < questions[i].options.length; j++) {
        await client.query('insert into options(question_id, label, position) values ($1, $2, $3)',
          [q.id, questions[i].options[j], j]);
        nOptions++;
      }
    }
    for (const v of lista)
      await client.query('insert into voters(email, name) values ($1, $2) on conflict do nothing',
        [v.email, v.name]);
    await client.query('commit');
    await setSettings({ results_sent_at: '' });
    res.json({
      ok: true, questions: questions.length, options: nOptions,
      voters: lista.length, duplicates,
      sinNombre: lista.filter((v) => !v.name).length,
    });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Error interno al guardar.' });
  } finally {
    client.release();
  }
});

// Permite añadir votantes olvidados sin perder los votos ya emitidos.
app.post('/api/admin/voters-add', auth, async (req, res) => {
  const el = await getElection();
  if (el.status === 'closed') return res.status(409).json({ error: 'La votación ya está cerrada.' });
  const { voters: lista } = parseVoters(req.body?.emails);
  if (!lista.length) return res.status(400).json({ error: 'No encontré ningún correo válido.' });
  let added = 0;
  for (const v of lista) {
    const r = await pool.query(
      'insert into voters(email, name) values ($1, $2) on conflict do nothing', [v.email, v.name]);
    added += r.rowCount;
  }
  res.json({ ok: true, added, ignored: lista.length - added });
});

app.post('/api/admin/open', auth, async (req, res) => {
  const el = await getElection();
  if (el.status !== 'draft') return res.status(409).json({ error: 'La votación ya fue abierta.' });
  const { rows: [{ n }] } = await pool.query('select count(*)::int as n from questions');
  if (n < 1) return res.status(400).json({ error: 'Configura la votación antes de abrirla.' });
  // Ninguna pregunta puede pedir más marcas que opciones tiene.
  const { rows: [{ bad }] } = await pool.query(`
    select count(*)::int as bad from questions q
    where (select count(*) from options o where o.question_id = q.id) < greatest(2, q.pick)`);
  if (bad > 0) return res.status(400).json({ error: 'Hay preguntas con menos opciones de las que piden marcar. Vuelve a guardar la votación.' });
  await pool.query(`update election set status = 'open' where id = 1`);
  if (req.body?.invite) runInvitations(true).catch((e) => console.error(e));
  res.json({ ok: true });
});

app.post('/api/admin/invite', auth, async (req, res) => {
  const el = await getElection();
  if (el.status !== 'open') return res.status(409).json({ error: 'Abre la votación antes de enviar invitaciones.' });
  if (job.running) return res.status(409).json({ error: 'Ya hay un envío en curso.' });
  runInvitations(!req.body?.all).catch((e) => console.error(e));
  res.json({ ok: true });
});

// Plan B si el correo no funciona: descargar los enlaces y repartirlos a mano.
app.get('/api/admin/links.csv', auth, async (_req, res) => {
  const el = await getElection();
  if (el.status !== 'open') return res.status(409).type('text').send('Abre la votación primero.');
  const { rows: voters } = await pool.query(
    'select id, email, name from voters where voted = false order by email');
  const csv = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const lines = ['nombre,correo,enlace'];
  for (const v of voters) lines.push(`${csv(v.name)},${v.email},${await issueLink(v.id)}`);
  res.set('Content-Disposition', 'attachment; filename="enlaces-votacion.csv"')
    .type('text/csv').send(lines.join('\n'));
});

app.post('/api/admin/close', auth, async (req, res) => {
  const el = await getElection();
  if (el.status !== 'open') return res.status(409).json({ error: 'La votación no está abierta.' });
  if (req.body?.notify && job.running)
    return res.status(409).json({ error: 'Espera a que termine el envío en curso.' });
  await pool.query(`update election set status = 'closed' where id = 1`);
  // El acta sale siempre al cerrar; el correo a los votantes es opcional.
  sendQuorum().catch((e) => console.error(e));
  if (req.body?.notify) runResults().catch((e) => console.error(e));
  res.json({ ok: true });
});

// Volver a enviar el acta de participación al organizador.
app.post('/api/admin/quorum-mail', auth, async (_req, res) => {
  const el = await getElection();
  if (el.status !== 'closed')
    return res.status(409).json({ error: 'El acta se genera al cerrar la votación.' });
  await sendQuorum();
  const s = await getSettings();
  if (s.quorum_error) return res.status(400).json({ error: s.quorum_error });
  res.json({ ok: true, to: s.quorum_to || '' });
});

// Enviar (o reenviar) los resultados a todos los votantes.
app.post('/api/admin/results-mail', auth, async (_req, res) => {
  const el = await getElection();
  if (el.status !== 'closed')
    return res.status(409).json({ error: 'Cierra la votación antes de enviar los resultados.' });
  if (job.running) return res.status(409).json({ error: 'Ya hay un envío en curso.' });
  runResults().catch((e) => console.error(e));
  res.json({ ok: true });
});

app.post('/api/admin/reset', auth, async (_req, res) => {
  if (job.running) return res.status(409).json({ error: 'Espera a que termine el envío de invitaciones.' });
  await pool.query('delete from votes');
  await pool.query('delete from options');
  await pool.query('delete from questions');
  await pool.query('delete from voters');
  await pool.query(`update election set title = '', description = '', status = 'draft' where id = 1`);
  await setSettings({ results_sent_at: '', quorum_sent_at: '', quorum_error: '', quorum_to: '' });
  job = { running: false, kind: '', total: 0, sent: 0, failed: [], finishedAt: null };
  res.json({ ok: true });
});

init()
  .then(() => app.listen(PORT, () => console.log(`Votación escuchando en ${BASE_URL}`)))
  .catch((e) => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
