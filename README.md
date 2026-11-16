# App de votación

Votación para un grupo cerrado: lista de correos definida por el organizador,
una o varias preguntas en una misma papeleta (cada una de opción única o de
elegir N candidatos), enlace personal de un solo uso enviado por correo, voto
secreto y panel de administración guiado.

**Las instrucciones completas paso a paso están en el documento
"Manual de la app de votación".** Esto es solo el resumen técnico.

## Puesta en marcha (resumen)

1. Sube estos archivos a un repositorio de GitHub.
2. En Render: **New → Blueprint**, elige el repositorio. El archivo
   `render.yaml` crea el servicio web y la base de datos, y los conecta.
   Render solo te pedirá `ADMIN_PASSWORD`.
3. Abre `https://TU-DIRECCION/admin` (usuario `admin`) y sigue los 4 pasos
   del panel: correo → votación → invitaciones → resultados.

El envío de correo **no** se configura con variables de entorno, sino dentro
del panel, con un botón para enviar un correo de prueba.

## Variables de entorno

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `DATABASE_URL` | sí | Postgres. El `render.yaml` la rellena solo. |
| `ADMIN_PASSWORD` | sí | Contraseña del panel `/admin`. |
| `BASE_URL` | no | Solo para un dominio propio. Si falta, se usa `RENDER_EXTERNAL_URL`. |

## Probar en local

```bash
npm install
cp .env.example .env     # ajusta DATABASE_URL y ADMIN_PASSWORD
npm run dev
```

En el panel, deja el envío de correo en **modo prueba**: los enlaces se
imprimen en la consola del servidor en vez de enviarse.

## Notas técnicas

- Una votación tiene N preguntas (`questions`), cada una con sus `options` y
  un `pick`: cuántas opciones debe marcar el votante en esa pregunta (1 por
  defecto; 4 para elegir cuatro candidatos de una lista). El votante responde
  todas las preguntas en una sola papeleta y se envían juntas: no se admiten
  respuestas parciales ni un número de marcas distinto de `pick`. Para
  permitir la abstención, el organizador añade una opción *Abstención*.
- Con `pick > 1`, cada papeleta deja `pick` filas en `votes`, así que el
  recuento informa también de `ballots` (= marcas / `pick`) y los porcentajes
  se calculan sobre las papeletas, no sobre el total de marcas.
- El voto se guarda en la tabla `votes`, que solo tiene `id` y `option_id`.
  No hay ninguna columna ni tabla que lo relacione con `voters`.
- Marcar al votante, anular su token e insertar sus N votos ocurre en una sola
  transacción, y el votante se marca con un único `UPDATE ... WHERE
  token_hash = $1 AND voted = false`. Así, dos peticiones simultáneas con el
  mismo enlace producen exactamente una papeleta, nunca votos a medias.
- Los tokens se guardan hasheados con SHA-256; la app nunca almacena el token
  en claro.
- El correo se envía por la API HTTP de Brevo (puerto 443) porque el plan
  gratuito de Render bloquea los puertos SMTP 25, 465 y 587. La opción SMTP
  existe para quien aloje la app en otro sitio o pague una instancia.
- El envío masivo corre en segundo plano y el panel lo consulta cada 2 s;
  `voters.invited_at` permite reanudarlo sin duplicar invitaciones.
