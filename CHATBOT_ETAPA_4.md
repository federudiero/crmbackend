# CRMSISTEM — Etapa 4: transferencia humana y preparación del piloto

Fecha de cierre técnico local: 2026-11-16.

## Estado

La transferencia humana quedó integrada con la sesión del chatbot y con la conversación CRM. No se realizó commit, push, deploy, llamada real a Meta ni escritura en Firestore real.

La ejecución productiva sigue bloqueada. Publicar un flujo no activa WhatsApp y el toggle administrativo solo registra `requestedEnabled`; `enabled` puede ser `true` únicamente si el backend valida todos los controles de preparación.

Los endpoints generales de envío conservan HTTP 410. El único remitente potencial es el servicio exclusivo del runtime del chatbot, que continúa inerte sin sus flags, allowlist, token por número, flujo habilitado y elegibilidad comercial.

## Auditoría de la implementación existente

- `lib/chatbotFlow.js` ya representaba `READY_FOR_HUMAN` y los motivos `FLOW_COMPLETED`, `CUSTOMER_REQUESTED_HUMAN` y `MAX_ATTEMPTS`.
- `lib/chatbotRuntime.js` agregaba `MESSAGE_LIMIT`, `SEND_ERROR` y `HUMAN_INTERVENTION`, pero antes de esta etapa no proyectaba la transferencia completa a `conversations` ni cancelaba en forma segura todo outbox pendiente.
- `lib/crmManagement.js` ya tenía asignación, autoasignación autorizada, estados, seguimiento, presupuesto, resultado comercial, motivo de pérdida y control de acceso por vendedor. Estas operaciones se reutilizaron; no se creó un CRM paralelo.
- El vendedor continúa respondiendo desde WhatsApp Business. No se agregó un chat de envío en React.
- `api/waWebhook.js` valida `X-Hub-Signature-256` sobre el body crudo con HMAC SHA-256 y `META_APP_SECRET`, ejecuta estadísticas primero y aísla los errores del runtime antes de responder HTTP 200.
- `lib/waStatisticsOnly.js` desduplica entradas y ecos mediante `gestionEventos` y no persiste cuerpos completos de mensajes.
- Los ecos `smb_message_echoes` ya alimentan la primera respuesta humana confirmada y ahora también suspenden la sesión. Su disponibilidad real sigue sin verificarse.

## Archivos nuevos

- `lib/chatbotOperations.js`: administración auditada de configuración por número y reactivación administrativa.
- `testing/chatbotOperations.test.js`: permisos, concurrencia, bloqueo de activación y reactivación.
- `CHATBOT_ETAPA_4.md`: este documento.
- Frontend: `src/components/crm/ChatbotRuntimeConfigPanel.jsx`.

## Archivos modificados en esta etapa

Backend:

- `lib/chatbotRuntime.js`
- `lib/chatbotRuntimeStore.js`
- `lib/crmManagement.js`
- `testing/chatbotRuntime.test.js`
- `testing/crmManagement.test.js`

Frontend:

- `src/services/crmManagement.js`
- `src/components/crm/ChatbotManagementConnected.jsx`
- `src/components/crm/ChatbotManagement.jsx`
- `src/components/crm/ChatbotRuntimeConfigPanel.jsx`
- `src/components/crm/CrmContactDetail.jsx`
- `src/components/crm/SellerCrmManagement.jsx`
- `src/components/crm/AdminCrmManagement.jsx`
- `tests/chatbot-preview/previewApi.js`
- `tests/chatbotManagement.visual.spec.js`
- `playwright.chatbot.config.js`

También permanecen los archivos de Etapas 1–3 ya presentes en ambos repositorios.

## Comportamiento implementado

### Transferencia y asignación

Al completar el formulario, solicitar una persona, superar intentos/límites o fallar un envío:

1. La sesión pasa a un estado suspendido.
2. La conversación recibe motivo, fecha, flujo/versión, paso actual y respuestas estructuradas.
3. Se conserva cualquier asignación manual existente.
4. Si está sin asignar, se usa solamente el vendedor activo configurado y validado contra la estructura existente de `wabaNumbers`.
5. Si no hay vendedor válido, queda `pending_assignment` y puede ser reclamada o asignada mediante las reglas CRM existentes.
6. El evento de transferencia es determinista respecto del webhook entrante, evitando duplicados.

La acción `chatbot_takeover` es transaccional: valida que el vendedor sea el asignado o pueda reclamar la bandeja, no sobrescribe a otro vendedor, suspende la sesión, cancela outbox pendiente y registra `chatbot_human_takeover`.

### Suspensión y carreras

- Los webhooks entrantes duplicados no avanzan dos veces la sesión.
- Los mensajes con timestamp anterior al último procesado se rechazan como `OUT_OF_ORDER`.
- Un eco humano suspende en forma idempotente.
- Los documentos de outbox en `pending`, `retry` o `sending` se cancelan durante transferencia/toma humana.
- Si el control humano aparece durante una llamada de envío, el resultado ya enviado no se puede retirar, pero el avance transaccional falla y se detienen los intents restantes.
- Solo un administrador puede reactivar; debe aportar la revisión exacta y queda un evento `chatbot_reactivated`.

### Panel del vendedor

Se agregaron filtros para listos para vendedor, solicitud/transferencia sin respuesta, asignados y control humano activo. La ficha muestra:

- nombre, teléfono, WABA receptor y vendedor;
- producto/servicio, cantidad, localidad y dirección cuando las claves del flujo usan esos alias;
- todas las respuestas estructuradas, sin depender de esos alias;
- origen/campaña, ingreso, transferencia, espera, flujo y estado;
- acciones existentes de seguimiento, presupuesto, vendido/perdido y motivo de pérdida;
- toma de control, sin interfaz de mensajería.

### Métricas administrativas

El dashboard incorpora contactos con bot, formularios completos, transferencias, solicitudes anticipadas, fallos/límites, pendientes de humano, tiempo confirmado hasta la primera respuesta humana, ventas/conversión y abandono estimado por pregunta después de 24 horas. También muestra transferencias por motivo y responsable. Las respuestas automáticas nunca cuentan como respuesta humana.

## API administrativa reutilizada/nueva

Todas las acciones usan el mismo endpoint autenticado `POST /api/crmManagement`; React no escribe directamente en Firestore.

| Acción | Rol | Concurrencia | Finalidad |
| --- | --- | --- | --- |
| `chatbot_takeover` | vendedor autorizado o admin | transacción de sesión/conversación | tomar control y cancelar outbox |
| `chatbot_runtime_configs_list` | admin | lectura backend | recursos y estado efectivo por número |
| `chatbot_runtime_config_update` | admin | `expectedRevision` | flujo, vendedor, límites y solicitud de activación |
| `chatbot_runtime_reactivate` | admin | revisión exacta de sesión | reactivación auditada |

Los errores de revisión devuelven HTTP 409 con `currentRevision` cuando corresponde.

## Modelo Firestore

Colecciones existentes reutilizadas:

- `conversations/{conversationId}`: proyección operativa `chatbotStatus`, `chatbotTransferStatus`, `chatbotTransferReason`, `chatbotTransferredAt`, `chatbotFlowId`, `chatbotFlowVersion`, `chatbotAnswers`, `chatbotFormCompleted`, paso/revisión y datos de toma/reactivación.
- `chatbotSessions/{conversationId}`: estado compacto, vendedor por defecto validado, límites efectivos, revisión y outbox pendiente.
- `chatbotOutbox/{outboxId}`: intents, intent siguiente, reintentos, límites y cancelación.
- `chatbotRuntimeEvents/{eventId}`: idempotencia de entradas y ecos.
- `gestionEventos/{eventId}`: auditoría CRM de transferencia, toma y reactivación.
- `chatbotRuntimeConfigs/{phoneId}`: configuración operativa por número, `requestedEnabled`, `enabled`, límites y revisión.

Colección nueva:

- `chatbotRuntimeConfigEvents/{eventId}`: auditoría inmutable de creación/actualización de configuración.

No se agregaron índices. Las nuevas operaciones usan documentos directos, scans administrativos pequeños ya existentes y filtros simples de igualdad. No se modificaron reglas Firestore: el repositorio no contiene un archivo de reglas desplegadas y su auditoría real sigue pendiente. El backend usa Admin SDK y aplica autorización propia.

## Controles de activación

`enabled` solo resulta verdadero cuando se cumplen simultáneamente:

- `CHATBOT_RUNTIME_ENABLED=true`;
- `CHATBOT_SEND_ENABLED=true`;
- Phone Number ID en `CHATBOT_ALLOWED_PHONE_IDS`;
- token del número en `CHATBOT_META_TOKENS_JSON`;
- `META_GRAPH_API_VERSION` válido;
- `META_APP_SECRET` y `META_WA_VERIFY_TOKEN` presentes;
- número WABA activo y flujo publicado correcto;
- `connectionVerifiedAt` establecido por una verificación backend controlada.

El frontend no puede establecer `connectionVerifiedAt`. Como no se autorizó consultar Meta ni conectar un número, ese control continúa pendiente y el piloto no puede activarse todavía.

## Variables de entorno

No se agregan secretos al frontend. Para un piloto futuro el backend requiere:

```text
CHATBOT_RUNTIME_ENABLED=false
CHATBOT_SEND_ENABLED=false
CHATBOT_ALLOWED_PHONE_IDS=<PHONE_NUMBER_ID_DE_PRUEBA>
CHATBOT_META_TOKENS_JSON={"<PHONE_NUMBER_ID_DE_PRUEBA>":"<TOKEN_BACKEND>"}
CHATBOT_MAX_MESSAGES_PER_SESSION=20
CHATBOT_MAX_MESSAGES_PER_MINUTE=10
CHATBOT_MAX_SEND_ATTEMPTS=3
META_GRAPH_API_VERSION=v27.0
META_APP_SECRET=<SECRETO_APP>
META_WA_VERIFY_TOKEN=<TOKEN_VERIFICACION>
```

El frontend conserva `VITE_API_BASE`. No debe recibir tokens de Meta.

## Preparación Meta y piloto seguro

Los permisos `whatsapp_business_messaging` y `whatsapp_business_management` y la fecha de aprobación son datos informados por el usuario; no fueron verificados contra la cuenta Meta.

La documentación oficial vigente indica:

- Los webhooks informan mensajes entrantes y estados; `messages` requiere `whatsapp_business_messaging` y los demás campos requieren `whatsapp_business_management`: [WhatsApp webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/).
- Coexistencia se configura mediante Embedded Signup para usuarios de WhatsApp Business app, exige requisitos de partner/proveedor, sincronización dentro de 24 horas y suscripciones adicionales a `account_update`, `history`, `smb_app_state_sync` y `smb_message_echoes`: [Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/).
- En coexistencia el throughput documentado es 20 mensajes por segundo y la ventana Cloud API de 24 horas no se abre/extiende por mensajes enviados desde WhatsApp Business app.
- Desde julio de 2025 Meta factura por mensaje entregado según categoría/mercado; desde el 1 de octubre de 2026 también hay cambios en mensajes de servicio y utility. Debe revisarse la tarifa vigente de Argentina antes del piloto: [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/).
- La Business Management API tiene límites separados y conviene usar webhooks: [Graph API rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/).

Procedimiento propuesto, todavía no ejecutado:

1. Crear/seleccionar exclusivamente un número de prueba y confirmar su WABA ID y Phone Number ID en Meta.
2. Confirmar si se usará Cloud API puro o coexistencia. No activar Embedded Signup por inferencia.
3. Generar un token de sistema de mínimo privilegio y almacenarlo únicamente en el backend.
4. Registrar la URL real de `api/waWebhook.js`, verificar challenge y firma, y comprobar suscripción `messages`.
5. Para coexistencia, validar además `account_update`, `history`, `smb_app_state_sync` y `smb_message_echoes`; confirmar `is_on_biz_app=true` y `platform_type=CLOUD_API` mediante una verificación backend autorizada.
6. Verificar elegibilidad del número, método de pago, límites y tarifa aplicable.
7. Publicar un flujo exclusivo del número de prueba, configurar un vendedor de prueba y límites mínimos.
8. Marcar únicamente contactos de prueba con `chatbotCommercialEligible=true`; mantener `chatbotPersonal`/`chatbotExcluded` protegidos.
9. Mantener ambos flags de envío en `false`, desplegar y observar webhooks/idempotencia sin respuestas.
10. Tras autorización expresa y evidencia de todos los controles, registrar `connectionVerifiedAt`, habilitar primero el runtime y luego el envío para un solo Phone Number ID.
11. Ejecutar una conversación entrante controlada, transferencia anticipada, toma humana y reactivación; detener ante cualquier discrepancia.

Limitación relevante: la documentación actual permite que algunos webhooks identifiquen usuarios por BSUID y omitan el teléfono. El runtime actual necesita `message.from` normalizable; esos casos se omiten de forma segura y deben implementarse antes de ampliar el piloto.

## Pruebas ejecutadas

Backend:

```text
npm test
66 tests aprobados, 0 fallos
```

Incluyen motor/regresión, finalización/transferencia anticipada, error, ausencia/asignación/preservación de vendedor, duplicados, orden, concurrencia, carrera envío-toma humana, contacto excluido, límites, configuración, HTTP 409, permisos de vendedor, reactivación y tiempo a primera respuesta humana.

Frontend:

```text
node --test tests/chatbotEditor.test.js
6 tests aprobados

npx playwright test --config playwright.chatbot.config.js
6 pruebas visuales aprobadas: 3 desktop + 3 mobile

npm run build
Build Vite aprobado

npx eslint <archivos modificados>
Sin errores ni advertencias
```

`npm run lint` completo detecta 3 errores y 11 advertencias preexistentes fuera del alcance de Etapa 4 (`InventoryPanel.jsx`, `src/services/api.js` y hooks de componentes legacy). Los archivos modificados pasan lint dirigido. El build conserva la advertencia previa de chunk principal mayor a 500 kB.

Las pruebas visuales requirieron ejecutar Playwright fuera del aislamiento local de sockets; no realizaron tráfico externo.

## Riesgos y pendientes

- No se validaron WABA, Phone Number ID, token, webhook, Embedded Signup, coexistencia, costos ni límites contra una cuenta real.
- `smb_message_echoes` no debe considerarse operativo hasta una prueba de coexistencia. Si no llega, el vendedor debe usar `Tomar control` antes de responder.
- El orden real entre eco humano y envío Cloud API solo puede cerrarse totalmente con un piloto; el código detiene intents restantes tras detectar la carrera.
- Las reglas Firestore desplegadas no están versionadas en este checkout.
- Los scans administrativos de configuraciones/números/flujos son adecuados para el volumen actual, pero deben paginarse si crecen de forma material.
- Falta soportar identidad BSUID cuando Meta omite el teléfono.
- Meta Marketing API continúa como objetivo prioritario: inversión, campañas, contactos, CPL, conversión, facturación atribuible y ROAS verificable.

## Rollback

1. En el panel administrativo, desmarcar la solicitud de activación por número y guardar con la revisión vigente.
2. Establecer `CHATBOT_SEND_ENABLED=false` y `CHATBOT_RUNTIME_ENABLED=false` en backend. Esto prevalece sobre Firestore.
3. Retirar el Phone Number ID de `CHATBOT_ALLOWED_PHONE_IDS` y el token de `CHATBOT_META_TOKENS_JSON`.
4. No borrar sesiones/outbox ni auditoría; conservarlos para diagnóstico. Los outbox suspendidos no se reanudan solos.
5. Revertir únicamente los archivos listados en este documento mediante el mecanismo de rollback del repositorio. No usar reset destructivo sobre el worktree porque contiene cambios ajenos.
6. Verificar nuevamente que las rutas generales de envío respondan HTTP 410.

Como no hubo deploy ni escritura real, el rollback operativo actual consiste simplemente en no desplegar estos cambios.
