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

- `create -f` es un **upsert**: por cada automatización del archivo manda un
  `POST` y, si la API responde 409 porque el id ya existe, un `PATCH`. La salida
  distingue creadas de actualizadas. Son hasta 2 llamadas por item (y un commit
  server-side por cada una), así que un archivo de 20 no es una operación
  barata ni instantánea para el resto de los clientes.
- El `PATCH` mergea **top-level**: un campo que el archivo no trae se
  **conserva** (antes, con el replace masivo, se borraba). Para vaciar una
  sección hay que mandarla explícitamente; y para cambiar algo anidado
  (`trigger.sensorTriggers[].sensorBindingId`) va el objeto `trigger` completo.
- Con varias automatizaciones en el archivo el corte es **fail-fast**: al primer
  error se aborta y se informa qué quedó aplicado, dónde cortó y qué no se
  intentó (exit ≠ 0).
- **Reaplicar el archivo corregido** es seguro para los items **con id** (el
  segundo intento los actualiza). Un item **sin id** NO es re-aplicable: cada
  `POST` acuña un id nuevo, así que volver a mandarlo crea un duplicado sobre el
  mismo trigger. Cuando eso pasa, el reporte lista los ids que acuñó la API y
  avisa de no reaplicar el archivo tal cual.
- `delete`/`enable`/`disable` sobre un id inexistente fallan con el 404 de la
  API y exit ≠ 0.

**Ojo con el flujo al re-aplicar un export.** `show --format json` estampa
`"flowDerived": true` en toda automatización cuyo `flow` es la proyección del
formato viejo — en esta casa, todas. La API **descarta `flow` y `when`** en los
items que traen esa marca (para no persistir un flujo derivado que quedaría
stale respecto de `actions`), así que exportar → editar el flujo → re-aplicar
**no guarda la edición**. El CLI lo avisa; para que se persista hay que quitar
`"flowDerived"` de ese item del archivo.

**Editar una automatización con `sourceAction: "toggle"`** falla hoy con 400: el
DTO del `PATCH` de la API valida más angosto que el del `POST`/`PUT`
(EugeValeiras/CCE#109). No es el archivo. El CLI lo señala en el mensaje.

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
`--if-match '*'` escribe sin chequeo, a tu riesgo.

> Para mutaciones puntuales usá `cce automations` (item-level): no necesitan
> versión porque no pueden pisar al resto del array.

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
