# cce-cli

CLI para CCE (Control de Casa). Permite listar/controlar dispositivos, disparar
escaneos de proveedores, ejecutar y editar automatizaciones, y observar eventos
en tiempo real desde la terminal — cubriendo las funcionalidades de CCE-API sin
abrir el dashboard.

## Requisitos

- Node.js 18+
- CCE-API corriendo (por defecto `http://localhost:3000`)

## Instalación local

```bash
cd /Users/eugeniovaleiras/workspace/CCE/CCE-CLI
npm install
npm run build
npm link    # deja `cce` disponible en $PATH
```

Desarrollo con recarga:

```bash
npm run start:dev -- devices list
```

Tests (`node:test` sobre `tsx`, con el cliente HTTP falso — nunca pegan a una
API real) y chequeo de tipos de `src/` + `test/`:

```bash
npm test
npm run typecheck
```

## Configuración

El CLI lee config de (en orden de prioridad):

1. Flags: `--api-url`, `--format`
2. Env vars: `CCE_API_URL`, `CCE_FORMAT`
3. Archivo `~/.cce/config.json`

Inicializar el archivo:

```bash
cce config init
cce config path                                      # muestra la ruta
cce config set apiUrl http://192.168.0.10:3000
cce config set providers.hue.bridgeIp 192.168.0.50
cce config set providers.hue.apiKey abcd1234
cce config set providers.tuya.accessId xxxx
cce config set providers.tuya.accessSecret yyyy
cce config set providers.tuya.region us
```

## Comandos

### `devices`

```bash
cce devices list                                     # tabla de dispositivos mergeados
cce devices list --raw                               # bindings crudos + sugerencias de merge
cce devices show dev_abc123
cce devices state dev_abc123 --on
cce devices state dev_abc123 --off
cce devices state dev_abc123 --bri 200 --hue 25000 --sat 200
cce devices state dev_abc123 --toggle
cce devices delete dev_abc123
cce devices merge dev_target dev_source
cce devices split dev_abc123 hue_3
cce devices prefer dev_abc123 matter_1
```

### `scan`

```bash
cce scan hue          # dispara POST /hue/lights/scan + /hue/sensors/scan
cce scan tuya         # discover LAN + Cloud de Tuya
cce scan tuya --device abc --device def
cce scan ewelink      # discover eWeLink
cce scan z2m          # informativo (Z2M no expone HTTP scan)
```

### `automations`

```bash
cce automations list
cce automations show auto_1
cce automations enable auto_1
cce automations disable auto_1
cce automations run auto_1
cce automations create -f ./nueva-auto.json
cce automations delete auto_1
```

> `automations run` ejecuta las acciones cliente-side contra `/devices/:id/state`.
> Actions `notification` y `alarm` se saltean (requieren ejecución server-side).

**Escrituras item-level.** `create`, `delete`, `enable` y `disable` tocan UNA
automatización por llamada (`POST` / `PATCH` / `DELETE /api/config/automations/:id`).
Ya no leen ni reenvían el array entero, así que no pueden pisar lo que la App o
el Dashboard hayan escrito en el medio.

- `create -f` es un **upsert**, y **la forma del body decide el método**:
  - sin `id` → `POST` (la API acuña el id);
  - con `id` y las cuatro claves que la API exige para crear
    (`name`, `enabled`, `trigger`, `actions`) → `POST` y, si responde 409
    porque ya existe, `PATCH`;
  - con `id` y **forma parcial** (`{"id":"auto_1","enabled":false}`) → `PATCH`
    directo, una sola llamada. Un 404 acá es «no existe», que es lo que pasó.

  Nunca se cae al `PATCH` por un error del `POST`: el DTO del `PATCH` es todo
  opcional, así que un body que el `POST` rechazó se escribiría igual, a medias.
- El `PATCH` mergea **top-level**: un campo que el archivo no trae se
  **conserva** (antes, con el replace masivo, se borraba). Para vaciar una
  sección hay que mandarla explícitamente; y para cambiar algo anidado
  (`trigger.sensorTriggers[].sensorBindingId`) va el objeto `trigger` completo.
- El CLI **se niega a mandar** tres cosas que la API acepta y después no puede
  leer: un campo en `null` (el `PATCH` lo guarda y a partir de ahí toda lectura
  de la config falla), una clave que la API no conoce (`"triger"` → la descarta
  en silencio y guarda el resto, dejando la automatización a medio escribir; el
  error sugiere la clave correcta), y un item que sólo trae `id` (un commit sin
  cambios). En los tres casos no sale ninguna petición.
- Con varias automatizaciones en el archivo el corte es **fail-fast**: al primer
  error se aborta y se informa qué quedó aplicado, dónde cortó y qué no se
  intentó (exit ≠ 0). Todo el reporte sale por **stderr**, junto.
- **Reaplicar el archivo corregido** es seguro para los items **con id** (el
  segundo intento los actualiza). Un item **sin id** NO es re-aplicable: cada
  `POST` acuña un id nuevo, así que volver a mandarlo crea un duplicado sobre el
  mismo trigger. Cuando eso pasa, el reporte lista los ids que acuñó la API y
  avisa de no reaplicar el archivo tal cual.
- Si el CLI **no puede saber** si la escritura ocurrió —la conexión se cortó
  después de mandar el pedido, la API devolvió 5xx (que puede llegar después de
  guardar), o aceptó el `POST` sin decir con qué id— lo dice como **estado
  desconocido** y manda a verificar con `list` antes de reintentar. Una API
  caída (`ECONNREFUSED`) NO es eso: ahí no salió nada y el CLI lo afirma.
- `delete`/`enable`/`disable` sobre un id inexistente fallan con el 404 de la
  API y exit ≠ 0.

**Ojo con el flujo al re-aplicar un export.** `show --format json` estampa
`"flowDerived": true` en toda automatización cuyo `flow` es la proyección del
formato viejo — en esta casa, todas. Ese flujo es de la API, no tuyo: el CLI
**quita `flow`/`when` del envío** (la API los descartaría igual) y lo avisa, así
que editar el flujo en un export y re-aplicarlo **no lo persiste**. Para
escribir un flujo propio hay que mandarlo **sin la marca** `"flowDerived"` **y
con las `actions` que le correspondan**: si mandás el flujo viejo junto a
`actions` nuevas, el motor corre el flujo y el Dashboard muestra las actions.

**Editar una automatización con `sourceAction: "toggle"`** falla hoy con 400: el
DTO del `PATCH` de la API valida más angosto que el del `POST`/`PUT`
(EugeValeiras/CCE#109). No es el archivo, y **no hay que cambiarlo a `on`/`off`**
—cambiaría lo que hace la automatización—: el CLI lo señala en el mensaje.

### `config`

```bash
cce config show              # GET /api/config
cce config show hue          # GET /api/config/hue
cce config show automations
echo '{"bridgeIp":"192.168.0.50","apiKey":"abcd"}' | cce config set-remote hue
cce config local             # config local (~/.cce/config.json)
cce config set <keyPath> <value>   # dot notation
cce config unset <keyPath>
```

`config set-remote automations` es el único replace masivo que queda en el CLI
(pisa el array entero) y **exige `--if-match <version>`**:

```bash
cce config show automations > autos.json   # imprime la versión por stderr
# … editás autos.json …
cat autos.json | cce config set-remote automations --if-match 620
```

La versión tiene que ser la de la lectura **en la que se basó la edición**, no
una de recién: si la App creó algo mientras editabas, la API responde 409, no se
escribe nada, y el CLI dice con qué versión reintentar. Un `If-Match` tomado de
un `GET` hecho al momento de escribir coincidiría siempre y no protegería de
nada — que es exactamente el incidente que este chequeo existe para evitar.

`--if-match '*'` escribe sin chequeo, a tu riesgo — **con comillas**: sin ellas
el shell expande el `*` al primer archivo del directorio. El CLI valida que la
versión sea un número (o `*`) antes de mandar nada, porque la API compara con
`Number()` y devolvería el mismo 409 que una versión vieja.

Este camino le saca el flujo derivado a cada item igual que `create`, y avisa.

La sección se normaliza antes de decidir nada: la API enruta sin distinguir
mayúsculas ni la barra final, así que `Automations` y `automations/` son la
misma ruta y también exigen `--if-match`.

> Para mutaciones puntuales usá `cce automations` (item-level): no necesitan
> versión porque no pueden pisar al resto del array.

### `alarm`

```bash
cce alarm status             # GET /api/config/alarm-armed
cce alarm arm
cce alarm disarm
cce alarm test-mode          # sólo muestra el estado
cce alarm test-mode on       # PUT /api/config/alarm-test-mode { enabled: true }
cce alarm test-mode off
```

**Modo prueba** (CCE#122): con la alarma armada, el disparo por sensor sigue
ocurriendo pero llega **sólo como push** — sin sirena, sin overlay, sin
repetición y sin atravesar el modo silencio del iPhone. Es para acostumbrarse a
la alarma sin que cada prueba tome la pantalla del panel.

Es un toggle **manual**: no vence solo. Por eso `status` y `arm` avisan por
stderr cuando está activo — una alarma muda que dice "armada" a secas es una
trampa. El aviso va por stderr a propósito: `cce alarm status --format json |
jq` sigue recibiendo JSON válido.

Con la alarma **desarmada** el aviso baja el tono: gritar "no va a sonar" sobre
una alarma que no iba a sonar igual convierte en rutina un mensaje cuyo valor
entero es ser raro.

`test-mode on|off` reporta lo que confirmó el **backend**, no lo que se pidió:
una respuesta sin `enabled` sale con error en vez de prometer un cambio que
quizá no se guardó.

`test-mode` sólo acepta `on` u `off`: cualquier otra cosa se corta en el CLI sin
mandar nada, porque adivinar acá es silenciar la alarma de una casa por un typo.

### `events live`

```bash
cce events live
cce events live --device dev_abc123
cce events live --event light:changed --event automation:executed
cce events live --json | jq .
```

Eventos: `light:changed`, `device:state-changed`, `automation:executed`,
`alarm:armed-changed`, `alarm:triggered`.

## Flags globales

- `--api-url <url>` — override del base URL (equivale a `CCE_API_URL`).
- `--format <table|json|csv>` — formato de salida para listados.

## Verificación rápida

```bash
cce config show > /dev/null && echo "API OK"
cce devices list
cce devices list --format json | jq '.[0]'
cce events live     # dejá corriendo y cambiá una luz desde el dashboard
```

## Estructura

```
src/
├── bin/cce.ts                # Entry point
├── commands/
│   ├── devices.ts
│   ├── scan.ts
│   ├── automations.ts
│   ├── config.ts
│   └── events.ts
├── lib/
│   ├── api-client.ts         # axios wrapper + provider headers
│   ├── socket-client.ts      # socket.io-client
│   ├── user-config.ts        # ~/.cce/config.json
│   └── format.ts             # table / json / csv
└── types/api.ts              # types copiados de CCE-API
```

## Fuera del scope V1

- Autenticación (la API actual asume LAN confiable).
- Publicación en npm.
- Autocompletado de shell.
