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
