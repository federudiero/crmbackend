# Corrección del límite Vercel Hobby

Se pasó de 14 archivos de funciones en `api/` a **3**:

- `api/waWebhook.js` (intacto)
- `api/upload.js` (intacto)
- `api/index.js` (router: carga los demás handlers desde `handlers/`)

`vercel.json` preserva las rutas de los handlers trasladados mediante rewrites exactas. No se cambiaron las implementaciones internas de esos handlers.

## Despliegue

1. Antes de reemplazar el repositorio, hacer backup y conservar las variables de Vercel.
2. Subir el contenido de esta carpeta a la **raíz del repositorio** (no subir la carpeta contenedora), eliminando los archivos antiguos de `api/` que ahora están en `handlers/`.
3. **No incorporar archivos privados** como `serviceAccountKey.json`, `.env`, `.vercel/` o `node_modules/` a Git.
4. Configurar `CORS_ORIGIN` en Vercel con los orígenes permitidos y redesplegar.
5. Verificar `/api/crmManagement` y `/api/inventory` con preflight OPTIONS y POST autenticado.
6. Verificar GET challenge de `/api/waWebhook` y webhook POST en un entorno de pruebas, envío de mensajes, subida de medios y demás rutas existentes.

## Alcance y riesgos

- Se mantuvieron los mismos módulos de negocio y URLs públicas.
- `api/index.js` comparte memoria y límites de una sola función entre varias rutas. Es necesario realizar smoke tests en Vercel real, principalmente tamaño del paquete y rutas rewrites.
- Las pruebas locales no equivalen a un deployment exitoso de Vercel.
- Este cambio NO corrige por sí mismo los problemas de conectividad de Firebase.
