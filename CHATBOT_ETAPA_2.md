# Chatbot comercial — Etapa 2

Fecha: 5 de noviembre de 2026.

## Estado de la etapa

Backend implementado y verificado. Editor y simulador visual frontend pendientes por falta de permiso de escritura sobre el repositorio `crmforntend-master`.

No se modificaron webhooks, rutas de envío, respuestas HTTP 410, estadísticas, inventario, autenticación ni atribución comercial.

## Diagnóstico de seguridad y persistencia

- Firestore `(default)` del proyecto `crmsistem-d3009` usa edición Standard y modo Native.
- No existe `firebase.json`, `firestore.rules` ni `firestore.indexes.json` en los repositorios locales inspeccionados.
- `docs/SEGURIDAD.md` contiene un ejemplo histórico de reglas, pero no demuestra cuáles están desplegadas actualmente.
- Firebase CLI no ofrece en este entorno un comando para descargar las reglas desplegadas.
- El frontend ya inicializa Firestore para otras funciones, pero el chatbot no accede directamente a sus colecciones.
- Todas las operaciones nuevas pasan por `POST /api/crmManagement`, Firebase ID token y la autorización existente `actor.isAdmin`.
- Admin SDK omite reglas Firestore. Por eso la seguridad depende de autenticar y autorizar cada acción antes de leer o escribir.

Decisión: no modificar reglas y no habilitar acceso cliente a `chatbotFlows` ni `chatbotFlowEvents`. La interfaz React deberá usar exclusivamente el servicio HTTP autenticado existente.

## Modelo persistido

### `chatbotFlows/{flowId}`

- `schemaVersion`: versión del documento.
- `name`, `description`: metadatos administrativos.
- `businessPhoneId`: número empresarial opcional, validado como identificador numérico.
- `status`: `draft`, `published` o `deleted`.
- `runtimeEnabled`: siempre `false` en Etapa 2.
- `revision`: entero usado para concurrencia optimista.
- `draft`: flujo normalizado por el motor de Etapa 1.
- `validationWarnings`: advertencias devueltas por el mismo motor.
- `versionCount`, `publishedVersion`: historial publicado.
- `hasUnpublishedChanges`: diferencia entre borrador y última publicación.
- campos de creación, modificación, publicación, restauración y borrado con UID, email y timestamp.

### `chatbotFlows/{flowId}/versions/{versionId}`

Snapshot inmutable de una publicación:

- `version` y `sourceRevision`;
- `flow` normalizado y validado;
- `businessPhoneId`;
- `runtimeEnabled: false`;
- actor y fecha de publicación.

Restaurar una versión no altera el snapshot ni cambia inmediatamente la versión publicada. Copia el snapshot al borrador, incrementa `revision` y marca `hasUnpublishedChanges: true`. Para publicarlo se crea una versión nueva.

### `chatbotFlowEvents/{eventId}`

Auditoría mínima de creación, edición, publicación, duplicación, restauración y borrado. No guarda mensajes, tokens ni payloads de Meta.

## Acciones administrativas

Todas usan el endpoint CRM existente.

| Acción | Función |
| --- | --- |
| `chatbot_flows_list` | Lista resúmenes; excluye eliminados por defecto. |
| `chatbot_flow_get` | Obtiene borrador y metadatos. |
| `chatbot_flow_create` | Crea un borrador validado. |
| `chatbot_flow_update` | Actualiza usando `expectedRevision`. |
| `chatbot_flow_delete` | Borrado lógico recuperable a nivel de datos. |
| `chatbot_flow_duplicate` | Crea un borrador independiente. |
| `chatbot_flow_publish` | Crea una versión inmutable, sin habilitar runtime. |
| `chatbot_flow_versions` | Devuelve historial ordenado por versión descendente. |
| `chatbot_flow_restore` | Restaura una versión como borrador nuevo. |
| `chatbot_validate` | Valida mediante el motor de Etapa 1. |
| `chatbot_simulate` | Simula mediante el motor de Etapa 1. |

Las mutaciones de un flujo existente requieren `expectedRevision`. Si otra sesión lo modificó, la API devuelve HTTP 409 y `details.currentRevision`.

Los errores de validación devuelven HTTP 422 con `details.errors` y `details.warnings`, incluyendo rutas y ciclos detectados por `lib/chatbotFlow.js`.

## Garantías de seguridad

1. Solo `actor.isAdmin` puede ejecutar operaciones de lectura o escritura.
2. Crear, actualizar y publicar vuelven a validar el flujo en backend.
3. Ningún payload puede establecer `runtimeEnabled`.
4. Borradores, versiones y duplicados persisten `runtimeEnabled: false`.
5. Publicar solo crea una versión administrativa; no conecta el flujo al webhook.
6. El borrado es lógico para conservar auditoría e historial.
7. No se almacenan conversaciones ni mensajes del simulador.
8. No hay secretos nuevos ni variables de entorno nuevas.

## Índices y reglas

No se requieren índices compuestos:

- la lista de flujos ordena únicamente por `updatedAt`;
- el historial ordena únicamente por `version` dentro de una subcolección;
- ambos usan índices de campo único de Firestore Standard.

No se agregaron ni desplegaron reglas. Antes de cualquier acceso directo desde cliente deberá incorporarse al workspace la configuración real de Firebase y auditar las reglas desplegadas. La implementación actual evita ese riesgo usando solo backend.

## Tests agregados

`testing/chatbotManagement.test.js` cubre:

- permisos administrativos;
- creación, lectura y listado;
- edición y conflictos de concurrencia;
- rechazo de flujos inválidos;
- publicación y snapshots inmutables;
- historial de versiones;
- restauración como borrador;
- duplicación;
- borrado lógico;
- invariantes `runtimeEnabled: false`.

La suite total tiene 38 tests aprobados.

El lint de solo lectura del frontend se ejecutó sobre el estado existente y falla antes de incorporar el editor: 3 errores preexistentes (`InventoryPanel.jsx` y dos bloques inalcanzables en `services/api.js`) más 11 advertencias de hooks. No se modificaron porque no pertenecen al chatbot y el repositorio no es escribible.

## Verificación backend

```powershell
node --check .\lib\chatbotManagement.js
node --check .\lib\chatbotFlow.js
node --check .\lib\crmManagement.js
node --check .\handlers\crmManagement.js
npm test
git diff --check
```

## Frontend pendiente

Repositorio inspeccionado:

`C:\Users\feder\Desktop\programacion\crm\crmforntend-master`

El entorno actual permite leerlo, pero solo estas raíces tienen escritura:

- `C:\Users\feder\Desktop\programacion\crm\crmbackend-master`
- `C:\Users\feder\.codex\visualizations\2026\11\05\01a1abdf-e68a-7ef0-bed7-3b4c608b8cbc`

Para continuar debe agregarse como raíz escribible del workspace:

`C:\Users\feder\Desktop\programacion\crm\crmforntend-master`

Cambios frontend previstos una vez habilitado:

1. agregar las acciones nuevas a `src/services/crmManagement.js`;
2. crear `src/components/crm/ChatbotManagement.jsx`;
3. agregar la pestaña administrativa `Chatbot` en `src/components/AdminPanel.jsx`;
4. editor mobile-first de metadatos, preguntas, opciones, validaciones y bifurcaciones;
5. ordenar preguntas sin librerías adicionales;
6. historial, publicar, duplicar, borrar y restaurar;
7. simulador conversacional llamando `chatbot_validate` y `chatbot_simulate`, sin copiar el motor al navegador;
8. build, ESLint y tests disponibles en el frontend.

El build de Vite queda pendiente. Aun redirigiendo `dist` al backend, Vite necesita crear `node_modules/.vite-temp` dentro de `crmforntend-master` para cargar `vite.config.js`; el sandbox lo rechazó con `EPERM`. Requiere el permiso de escritura indicado arriba.

## Rollback backend

1. retirar el despacho de acciones de `lib/crmManagement.js`;
2. retirar la inclusión de `error.details` de `handlers/crmManagement.js` si no se usa por otro módulo;
3. retirar `lib/chatbotManagement.js` y `testing/chatbotManagement.test.js`;
4. si se hubieran creado datos de prueba manualmente, conservarlos o eliminarlos explícitamente desde Firebase Console; no hay migración automática.

No se hizo commit, push, deploy ni escritura en el proyecto Firestore real durante el desarrollo y los tests.
