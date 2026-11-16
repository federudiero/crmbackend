# Chatbot comercial — Etapa 1

Fecha del diagnóstico: 5 de noviembre de 2026.

## Alcance implementado

Esta etapa agrega únicamente diseño ejecutable y simulación sin envíos:

- esquema normalizado de flujo comercial;
- validación de preguntas, opciones, destinos, bifurcaciones y ciclos;
- tipos `text`, `buttons`, `list`, `number`, `location` y `contact`;
- validaciones de longitud, rango y patrones acotados;
- máquina de estados determinista para simulación;
- transferencia por flujo completado, solicitud de vendedor o máximo de intentos;
- respuestas comerciales estructuradas, sin guardar mensajes completos;
- acciones administrativas `chatbot_validate` y `chatbot_simulate` sobre el endpoint CRM existente;
- tests unitarios del recorrido, errores y permisos.

No se agregó persistencia, UI, envío a Meta, procesamiento del webhook ni activación en producción.

## Diagnóstico del código existente

1. El backend usa Node.js ESM, Vercel y `firebase-admin`.
2. La base `(default)` del proyecto `crmsistem-d3009` es Firestore Native, edición Standard.
3. `lib/crmManagement.js` ya autentica Firebase ID tokens y aplica roles administrativos y de vendedor.
4. `api/index.js` devuelve HTTP 410 para `sendMessage`, `send-template`, `bulk-optin` y `templates`. Ese bloqueo permanece intacto.
5. `api/waWebhook.js` tiene cambios locales que verifican `X-Hub-Signature-256`, ejecutan `processStatisticsOnly()` y retornan inmediatamente. El resto del procesamiento queda inaccesible. Esta etapa no altera ese comportamiento.
6. `lib/waStatisticsOnly.js` conserva identificadores, atribución confirmada y métricas mínimas, sin cuerpos completos ni medios.
7. `lib/coexistenceOnboarding.js` tiene un piloto protegido por `META_COEXISTENCE_PILOT_ENABLED`, verifica el activo contra Graph y descarta el token temporal. No existe todavía un mecanismo seguro y operativo para credenciales de envío por número.
8. El frontend está en el repositorio hermano `crmforntend-master`. No fue modificado en esta etapa.

## Causa raíz de los bloqueantes actuales

El CRM está intencionalmente en modo estadísticas. Aunque el repositorio conserva handlers históricos de envío, tanto el router como esos handlers los bloquean con HTTP 410. Además, el webhook retorna después de registrar estadísticas. Por lo tanto, hoy no hay un canal autorizado para respuestas automáticas y no debe reutilizarse ni reactivarse el envío general.

## Bloqueantes externos de Meta

Antes de implementar o habilitar envíos deben comprobarse en la cuenta real:

1. Aplicación y negocio aptos para WhatsApp Business Platform, con revisión y acceso avanzado cuando corresponda.
2. Permisos efectivos `whatsapp_business_messaging` y `whatsapp_business_management`; `business_management` solo si las operaciones sobre el portfolio lo requieren.
3. Configuración de Embedded Signup específica para incorporar usuarios de WhatsApp Business App mediante coexistencia.
4. Elegibilidad real de cada número, pertenencia al WABA, suscripción de la app y estado de registro.
5. Recepción real de `messages`, estados y `smb_message_echoes` para cada número piloto. Los ecos no deben considerarse garantizados ni ordenados hasta comprobarlo.
6. Credencial de sistema de larga duración o mecanismo equivalente, almacenado exclusivamente en backend y aislado por número. El código actual descarta el token de alta y no permite enviar.
7. Ventana de atención de 24 horas, plantillas aprobadas fuera de ventana, opt-in y mecanismo claro de escalamiento humano.
8. Precios vigentes por mensaje entregado, mercado y categoría. Los importes deben obtenerse de datos verificables de Meta; no se infieren ni se fijan en código.
9. Política de privacidad, retención, exclusión de conversaciones privadas y autorización empresarial para cada número mixto.

Referencias oficiales consultadas:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes
- https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
- https://whatsappbusiness.com/products/platform-pricing/
- https://whatsappbusiness.com/policy/

## Modelo de estados

El estado del bot debe ser independiente de `gestionStatus` y del resto de los campos CRM.

| Estado | Uso | Transiciones permitidas |
| --- | --- | --- |
| `BOT_PENDING` | Contacto elegible, aún no iniciado | `BOT_ACTIVE`, `CANCELLED`, `ERROR` |
| `BOT_ACTIVE` | Ejecución interna del siguiente paso | `WAITING_FOR_CUSTOMER`, `READY_FOR_HUMAN`, `COMPLETED`, `ERROR` |
| `WAITING_FOR_CUSTOMER` | Pregunta emitida; espera respuesta | `BOT_ACTIVE`, `READY_FOR_HUMAN`, `CANCELLED`, `ERROR` |
| `READY_FOR_HUMAN` | Bot suspendido y transferencia registrada | `HUMAN_ACTIVE`, `COMPLETED` |
| `HUMAN_ACTIVE` | Intervención humana confirmada | `COMPLETED` |
| `COMPLETED` | Sesión terminada | terminal |
| `CANCELLED` | Exclusión, baja o cancelación | terminal |
| `ERROR` | Falla segura; el bot no responde | `READY_FOR_HUMAN`, `CANCELLED` mediante acción controlada |

Regla de seguridad: `READY_FOR_HUMAN`, `HUMAN_ACTIVE`, `COMPLETED` y `CANCELLED` nunca pueden producir un envío automático para esa sesión.

## Integración con el CRM existente

- `gestionStatus` continúa describiendo la gestión comercial existente.
- `chatbotStatus` describirá únicamente el ciclo automatizado.
- La transferencia puede actualizar `gestionStatus` a `pendiente` solo mediante una transición explícita y auditada en una etapa posterior.
- La asignación debe reutilizar las reglas y campos `assignedToUid`, `assignedToEmail` y `assignedToName` existentes.
- La primera respuesta humana se confirmará por `smb_message_echoes` o por una intervención manual autorizada. No se inferirá por abrir WhatsApp.
- La atribución publicitaria continuará dependiendo de identificadores `referral` confirmados; nunca de coincidencias de texto.

## Esquema de flujo de la Etapa 1

Ejemplo mínimo para validar o simular. Los productos y valores son entradas administrativas; el motor no trae catálogo propio.

```json
{
  "name": "Flujo comercial",
  "welcomeMessage": "Mensaje configurable",
  "closingMessage": "Mensaje configurable",
  "maxAttempts": 3,
  "startQuestionId": "consulta",
  "transfer": {
    "onComplete": true,
    "humanKeywords": ["vendedor", "persona"],
    "message": "Mensaje configurable"
  },
  "questions": [
    {
      "id": "consulta",
      "key": "consulta",
      "prompt": "Pregunta configurable",
      "type": "text",
      "required": true,
      "validation": { "minLength": 2, "maxLength": 200 }
    }
  ]
}
```

Las bifurcaciones aceptan `equals`, `not_equals`, `contains`, `in` y `exists`. Los destinos deben existir y el grafo no puede contener ciclos. Esto garantiza que una simulación finalice y evita bucles de mensajes.

## Acciones administrativas nuevas

Ambas usan `POST /api/crmManagement`, Firebase ID token y rol administrador.

### Validar

```json
{
  "action": "chatbot_validate",
  "flow": {}
}
```

Devuelve `chatbot.valid`, `chatbot.errors`, `chatbot.warnings` y el flujo normalizado.

### Simular

```json
{
  "action": "chatbot_simulate",
  "flow": {},
  "responses": []
}
```

Devuelve el estado alcanzado, mensajes simulados y respuestas estructuradas. No escribe en Firestore ni llama a Meta.

## Modelo propuesto para Etapas 2 a 4

No se crearon estas colecciones todavía:

- `chatbotFlows/{flowId}`: metadatos, número empresarial, borrador y estado administrativo.
- `chatbotFlows/{flowId}/versions/{version}`: snapshot inmutable publicado.
- `chatbotConversations/{conversationId}`: versión fijada, paso, estado, respuestas estructuradas y tiempos.
- `chatbotConversations/{conversationId}/events/{eventId}`: auditoría mínima e idempotente, sin payload bruto.
- `chatbotOutbound/{idempotencyKey}`: reserva transaccional del envío y resultado de Meta.

La actualización de conversación y la reserva de salida deberán ocurrir en una transacción. El envío se realizará después de confirmar la reserva; el reintento reutilizará la misma clave de idempotencia.

Índices previstos, a confirmar contra las consultas finales:

- conversaciones por `businessPhoneId + chatbotStatus + transferredAt`;
- conversaciones por `assignedToUid + chatbotStatus + transferredAt`;
- flujos por `businessPhoneId + status`.

No se deben desplegar índices antes de implementar y medir las consultas reales.

## Variables futuras, no activadas

No se agregaron ni se requieren para la Etapa 1. Para etapas con Meta deberán definirse, sin valores en el repositorio:

- `CHATBOT_ENABLED=false`
- `CHATBOT_TEST_MODE=true`
- `CHATBOT_ALLOWED_PHONE_IDS`
- `CHATBOT_MAX_MESSAGES_PER_CONVERSATION`
- `CHATBOT_MAX_MESSAGES_PER_PHONE_PER_MINUTE`
- credenciales Meta server-side por número o una referencia a un almacén de secretos;
- las variables Meta existentes necesarias para firma, Graph API y Embedded Signup.

La implementación debe fallar cerrada si `CHATBOT_ENABLED` no es exactamente `true` o si el número no está autorizado.

## Verificación

Desde el backend:

```powershell
npm test
node --check .\lib\chatbotFlow.js
node --check .\lib\crmManagement.js
```

## Despliegue y rollback de esta etapa

No se debe desplegar todavía. Esta etapa es inerte mientras el frontend no invoque sus dos acciones administrativas.

Rollback:

1. quitar los casos `chatbot_validate` y `chatbot_simulate` de `handleCrmAction`;
2. quitar el import de `chatbotFlow.js` en `lib/crmManagement.js`;
3. retirar `lib/chatbotFlow.js` y `testing/chatbotFlow.test.js`.

No hay datos que migrar ni limpiar porque esta etapa no persiste nada.

## Riesgo residual y siguiente etapa

El principal riesgo no está en el simulador, sino en confundir una simulación con capacidad real de coexistencia y envío. La siguiente etapa segura es crear editor y persistencia versionada, todavía sin webhook ni salida a Meta. La activación real debe esperar la prueba por número de coexistencia, ecos, permisos, ventana y credenciales.
