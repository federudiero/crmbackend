# CRMSISTEM - Chatbot comercial - Etapa 3

Fecha: 2026-11-16.

## Estado de integración

Se implementó la base backend de Etapa 3, integrada al webhook pero inerte por defecto. No se realizó ninguna llamada real a Meta, no se modificó ningún número y no se activó ningún flujo.

La aprobación de `whatsapp_business_messaging` y `whatsapp_business_management` para la app `crmsistem` (App ID `2402827836778762`) es información provista por el solicitante. No fue verificada contra Meta porque no se usaron tokens ni el panel productivo.

## Auditoría previa

### Webhook

- Ruta real de Vercel: `/api/waWebhook`, servida por `api/waWebhook.js`. No tiene rewrite en `vercel.json`; usa la ruta por archivo de Vercel.
- `GET` compara `hub.verify_token` con `META_WA_VERIFY_TOKEN`.
- `POST` conserva el cuerpo crudo (`bodyParser: false`), limita el payload a 1 MB y valida `X-Hub-Signature-256` con HMAC SHA-256, `META_APP_SECRET` y `timingSafeEqual`.
- Primero ejecuta `processStatisticsOnly`. El runtime se ejecuta después y sus errores se aíslan para no provocar reintentos ni duplicar atribución.
- El bloque histórico posterior al `return EVENT_RECEIVED` continúa inalcanzable; no fue reactivado.

### Estadísticas existentes

`lib/waStatisticsOnly.js` ya desduplica mensajes entrantes mediante `gestionEventos/meta_in_<messageId>`, usa transacciones y persiste sólo identificadores, tipo, atribución recortada y horas. Los ecos `smb_message_echoes` alimentan la respuesta confirmada del vendedor sin guardar cuerpos completos.

### Modelo existente

- Conversación: `conversations/{phoneNumberId}__{telefonoNormalizado}`.
- Contactos: `contacts`, con compatibilidad legacy resuelta por `lib/conversationScope.js`.
- Eventos CRM/estadísticos: `gestionEventos`.
- Números empresariales existentes: `wabaNumbers` y campos `businessPhoneId`, `lastInboundPhoneId` o `scopedPhoneNumberId` según el documento.

El runtime reutiliza el mismo identificador scopeado; no crea otra conversación ni modifica estadísticas, inventario, Auth o atribución.

## Implementación

### `lib/chatbotRuntime.js`

- Extrae respuestas de texto, botones, listas, ubicación y contacto.
- Reutiliza `validateFlowDefinition`, `createSimulation` y `advanceSimulation`; no duplica la máquina de estados.
- Inicia, avanza y suspende sesiones.
- Detecta duplicados por ID de Meta y mensajes fuera de orden.
- Usa revisión optimista y reintenta conflictos de conversaciones simultáneas.
- Transfiere por palabra humana incluso en el primer mensaje.
- Suspende ante `smb_message_echoes` cuando coexistencia entrega ese evento.
- Permite reactivación sólo mediante método administrativo, revisión exacta y runtime habilitado. No se expuso una ruta HTTP de reactivación en esta etapa.
- Excluye por defecto toda conversación que no tenga `chatbotCommercialEligible: true`; también respeta `chatbotExcluded: true` y `chatbotPersonal: true`.

### `lib/chatbotRuntimeStore.js`

Persistencia exclusiva mediante Firebase Admin:

- `chatbotSessions/{conversationId}`: estado compacto, respuestas necesarias, flujo/versión, revisión, contadores y suspensión. No guarda el historial de mensajes de Meta ni los mensajes renderizados del bot.
- `chatbotRuntimeEvents/{hash}`: reserva idempotente de mensajes y ecos; el ID original se hashea.
- `chatbotOutbox/{hash}`: intenciones de salida, intentos, progreso parcial y resultado.
- `chatbotRateLimits/{phoneId_minute}`: límite transaccional por número y minuto.
- `chatbotRuntimeConfigs/{phoneId}`: activación explícita separada del snapshot administrativo.

La selección del flujo exige un documento de activación con `enabled: true`, `flowId` y `version`, además de un flujo publicado asignado al mismo número. Etapa 2 no crea esos documentos; por eso los snapshots conservan `runtimeEnabled: false` y no son ejecutables.

No se requieren índices compuestos nuevos: las lecturas son por ID de documento. No se cambiaron reglas. No existe un archivo local de reglas en este repositorio; antes de desplegar debe auditarse/exportarse la versión desplegada y confirmarse que estas colecciones no son accesibles desde clientes. El runtime usa Admin SDK.

### `lib/chatbotSender.js`

- Es el único módulo nuevo que construye y envía mensajes del chatbot.
- Requiere simultáneamente runtime habilitado, envío habilitado, número incluido en allowlist, token backend por número y versión Graph válida.
- Sólo permite mensajes libres dentro de las 24 horas posteriores al mensaje entrante.
- Construye texto, hasta 3 botones o listas de hasta 10 opciones.
- Usa timeout, clasifica 429/5xx y errores de red como reintentables.
- El outbox persiste `nextIntentIndex`: un reintento parcial no vuelve a enviar intenciones ya confirmadas localmente.

No se implementó envío de plantillas. Fuera de la ventana el servicio rechaza el envío; habilitar plantillas requerirá inventario aprobado, categoría/idioma y política definida para cada flujo. Esto evita inventar plantillas o iniciar conversaciones no autorizadas.

### `api/waWebhook.js`

Después de la validación de firma y las estadísticas llama a `processChatbotWebhook`. Con los valores por defecto devuelve sólo resultados `RUNTIME_DISABLED`; no crea sesiones ni outbox y no llama a Meta.

### Compatibilidad del motor

`lib/chatbotFlow.js` ahora rechaza más de 3 botones y valida etiquetas de hasta 20 caracteres; las listas mantienen el máximo de 10 y etiquetas de hasta 24 caracteres. No cambió ninguna transición. El editor frontend aplica los mismos límites de entrada, mientras la decisión de validez continúa en backend.

## Capas necesarias para activar una prueba controlada

Las cuatro deben existir; actualmente no se creó ninguna activación:

1. `CHATBOT_RUNTIME_ENABLED=true`.
2. El `phone_number_id` incluido en `CHATBOT_ALLOWED_PHONE_IDS`.
3. `chatbotRuntimeConfigs/{phoneId}` con `enabled: true`, `flowId` y `version` válidos.
4. La conversación marcada explícitamente con `chatbotCommercialEligible: true` y sin flags de exclusión.

Para enviar, además se requiere `CHATBOT_SEND_ENABLED=true`, token del número, versión Graph y ventana abierta.

## Variables de entorno

Variables existentes utilizadas por el webhook:

- `META_WA_VERIFY_TOKEN`
- `META_APP_SECRET`
- `FIREBASE_SERVICE_ACCOUNT`
- `FIREBASE_STORAGE_BUCKET`

Variables nuevas preparadas, todas backend-only:

- `CHATBOT_RUNTIME_ENABLED` - debe permanecer `false` o ausente.
- `CHATBOT_SEND_ENABLED` - debe permanecer `false` o ausente.
- `CHATBOT_ALLOWED_PHONE_IDS` - CSV de `phone_number_id`; vacío por defecto.
- `CHATBOT_META_TOKENS_JSON` - JSON `{ "phone_number_id": "token" }`; no configurado.
- `META_GRAPH_API_VERSION` - versión explícita, por ejemplo la vigente al momento de la prueba; no se fijó una versión productiva.
- `CHATBOT_MAX_MESSAGES_PER_SESSION` - default 20.
- `CHATBOT_MAX_MESSAGES_PER_MINUTE` - default 10 por número.
- `CHATBOT_MAX_SEND_ATTEMPTS` - default 3, máximo 5.

Nunca deben exponerse como `VITE_*` ni enviarse al frontend.

## Pruebas

`npm test`: 55 aprobadas, 0 fallidas. Incluye 17 casos nuevos/de regresión:

- duplicados;
- fuera de orden;
- simultaneidad y revisión optimista;
- fallo definitivo de envío;
- reintento parcial sin repetir mensajes ya confirmados;
- intervención del vendedor e idempotencia del eco;
- transferencia humana durante el flujo y en el primer mensaje;
- reactivación administrativa y rechazo de vendedor;
- número no autorizado;
- flujo sin activación;
- contacto excluido/personal;
- límite de mensajes;
- remitente inerte sin flags;
- rechazo de mensajes libres fuera de la ventana de 24 horas;
- payload interactivo;
- máximo de 3 botones y lista válida.

`node --check` aprobó `chatbotRuntime.js`, `chatbotRuntimeStore.js`, `chatbotSender.js` y `api/waWebhook.js`.

No se usó Firestore real, no se llamó a Graph API y no se desplegó.

## Configuración pendiente antes de una prueba Meta

1. Confirmar en Meta el WABA, `phone_number_id`, estado/calidad del número y vínculo con App ID `2402827836778762`.
2. Confirmar si el alta será Cloud API directa, Embedded Signup o coexistencia; no asumir ninguna.
3. Confirmar suscripciones reales del webhook `messages` y disponibilidad de `smb_message_echoes` para coexistencia.
4. Confirmar URL productiva exacta `/api/waWebhook`, challenge y firma en un entorno no productivo.
5. Crear un system user/token con alcance mínimo y rotación; cargarlo sólo en backend.
6. Auditar reglas Firestore desplegadas y acceso a las colecciones nuevas.
7. Definir qué conversaciones comerciales pueden llevar `chatbotCommercialEligible: true`; no marcar masivamente.
8. Crear una operación administrativa auditada para `chatbotRuntimeConfigs`; no escribirla desde React.
9. Definir plantillas aprobadas para cualquier mensaje fuera de ventana antes de implementar ese camino.
10. Ejecutar un piloto con un número de prueba allowlisted, límites bajos y monitoreo de outbox/sesiones.

## Riesgos y limitaciones

- La aprobación de permisos no demuestra que WABA, número, coexistencia, webhooks o token estén listos.
- La suspensión por intervención desde WhatsApp Business depende de que Meta entregue `smb_message_echoes`. Debe validarse con el modo real elegido.
- Como en cualquier API externa, existe una ventana mínima de entrega al menos una vez si Meta acepta un mensaje y la función cae antes de persistir el progreso. El outbox reduce reenvíos parciales, pero no puede prometer exactamente una vez sin soporte idempotente de Meta.
- Las plantillas todavía no están implementadas; el servicio falla cerrado fuera de la ventana.
- La reactivación existe sólo como servicio probado, sin endpoint administrativo, para evitar habilitación accidental.
- La ejecución productiva sigue bloqueada por diseño.

## Rollback

Rollback inmediato sin borrar datos:

1. Mantener o fijar `CHATBOT_RUNTIME_ENABLED=false` y `CHATBOT_SEND_ENABLED=false`.
2. Retirar la llamada a `processChatbotWebhook` de `api/waWebhook.js`; estadísticas continúan igual.
3. Revertir `lib/chatbotRuntime.js`, `lib/chatbotRuntimeStore.js`, `lib/chatbotSender.js` y sus pruebas.
4. Revertir únicamente el límite específico de botones en `lib/chatbotFlow.js` si fuera necesario.
5. Las colecciones nuevas pueden conservarse para auditoría. Si se decide eliminarlas, hacerlo después de exportarlas y con una operación explícita; este trabajo no borró datos.

Los endpoints generales de envío continúan HTTP 410. No se modificaron webhooks ajenos, inventario, Auth, estadísticas, atribución ni Marketing API. No se realizó commit, push ni deploy.
