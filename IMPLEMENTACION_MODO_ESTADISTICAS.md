# CRM · Modo exclusivamente estadístico — entrega técnica de preparación

Fuente: ZIPs del CRM frontend, CRM backend y sistemapedidos aportados por el usuario el 29/10/2026.

## Objetivo y alcance implementado
- Backend: las rutas de envío `sendMessage`, `send-template`, `bulk-optin` y `templates` devuelven HTTP 410. Los handlers mantienen un bloqueo redundante. No se ejecutan envíos de Cloud API desde estos endpoints.
- Frontend: `sendMessage` y `sendTemplate` rechazan cualquier intento. Los vendedores deben contestar en WhatsApp Business.
- Webhook `/api/waWebhook`: rechaza firmas Meta inválidas; usa el cuerpo crudo para validar `X-Hub-Signature-256`. Procesa `messages` y `smb_message_echoes` solo como metadatos, sin guardar cuerpo del mensaje ni medios ni payload bruto. Las referencias de anuncios se conservan sin atribución inferida por texto. Los ecos actualizan el cómputo de primera respuesta.
- Coexistencia: agregado flujo Embedded Signup (SDK Facebook en frontend, intercambio de code y verificación servidor de WABA/número, suscripción a webhook y asociación del número al vendedor). No se guardan tokens de conexión en Firestore.
- Vercel: se reutiliza `api/crmManagement` dentro de `api/index`, no hay función Serverless adicional.

## Archivos cambiados
Backend:
- api/index.js
- api/waWebhook.js
- handlers/sendMessage.js, handlers/send-template.js, handlers/bulk-optin.js, handlers/templates.js
- lib/crmManagement.js
- lib/waStatisticsOnly.js (nuevo)
- lib/coexistenceOnboarding.js (nuevo)

Frontend:
- src/services/api.js
- src/services/crmManagement.js
- src/components/crm/SellerCrmManagement.jsx
- src/components/crm/ConnectStatsWhatsApp.jsx (nuevo)

## Variables nuevas de backend (sin compartir secretos)
- `META_APP_ID`: ID real de app Meta Developers.
- `META_APP_SECRET`: secreto real de la misma app; también se usa para verificar la firma del webhook.
- `META_EMBEDDED_SIGNUP_CONFIG_ID`: Configuration ID de **Facebook Login for Business → WhatsApp Embedded Signup** habilitado para coexistencia (NO es el App ID).
- `META_GRAPH_API_VERSION`: versión Graph API soportada, ej. según la que Meta indique en tu app.
- `META_COEXISTENCE_PILOT_ENABLED`: queda omitida o `false` inicialmente. Solo habilitarla después de validar lo siguiente.
- `META_WA_VERIFY_TOKEN`: token de verificación del webhook ya existente.

## Bloqueos de producción — IMPORTANTE
1. **No desplegar sin validar** la lectura del cuerpo crudo de webhook en Vercel (bodyParser:false) y entrega de eventos reales firmados. De lo contrario no se recibirán eventos.
2. **No conectar números reales** sin aprobación efectiva de permisos `whatsapp_business_management`, `whatsapp_business_messaging` y Embedded Signup coexistencia para la app seleccionada; la verificación comercial no los reemplaza.
3. **Historial de coexistencia**: Meta puede requerir sincronizar el historial dentro de un plazo de onboarding. Esta versión NO implementa sincronización histórica ni su ciclo de confirmación. Decidir un mecanismo de manejo de eventos `history`, `smb_app_state_sync` y `account_update` respetando el requisito oficial vigente ANTES de habilitar el piloto. Para privacidad, no guardar contenido de mensajes históricos.
4. **Uso mixto laboral/personal**: el consentimiento de un vendedor no sustituye el análisis legal, avisos de privacidad y exclusión de conversaciones privadas. Esta versión no tiene listas de exclusión de particulares; NO habilitar hasta diseñarlas/validarlas con el cliente.
5. Verificar que todos los vendedores estén correctamente asociados a `wabaNumbers` y que las reglas de Firestore impidan escrituras/lecturas indebidas en esos registros. El endpoint servidor valida la cuenta WABA autorizada, pero debe auditarse la seguridad de Firestore en el proyecto real.
6. La nueva ingestión usa IDs de conversación scopeados por número receptor. Para números históricos, validar compatibilidad con la resolución legacy antes de producción.
7. Compatibilidad de Embedded Signup de Meta en versión v4/Phone-Number-First: verificar parámetros del SDK en documentación y configuración actuales. El código usa `featureType=whatsapp_business_app_onboarding`, pero esto por sí solo no acredita elegibilidad.
8. **Histórico**: mensajes ya guardados en Firestore no se eliminan; se requiere plan de retención/eliminación con autorización explícita.
9. La integración de Marketing API y las estadísticas de Etapa 2 no se han probado contra Meta real.
10. Los archivos de mensajería/chats heredados siguen presentes por compatibilidad, aunque el envío queda bloqueado. Es aconsejable retirar el UI de chat mediante un cambio de navegación controlado en la siguiente iteración.

## Pruebas disponibles
- `node --check` de todos los módulos JS modificados del backend: correcto.
- Revisión estática de que el router y los handlers de envío bloquean con 410: correcta.
- `npm ci --offline` del frontend **no pudo instalar dependencias** por paquete ausente en la caché (`yocto-queue`). No se ejecutó build completo ni e2e en este entorno.
- **No hay prueba real** contra Firebase, Meta ni Vercel.

## Procedimiento recomendado
1. Abrir el repositorio más reciente en Codex y comparar los archivos de este ZIP antes de integrarlos. Evitar sobrescribir commits locales más nuevos.
2. Revisar las 10 condiciones de producción de arriba. Implementar filtro de privacidad y manejo de sincronización obligatoria antes de activación.
3. Ejecutar `npm ci && npm run build` en frontend, `npm ci && npm test` en backend, y pruebas de integración con Firestore emulado.
4. Probar endpoint webhook firmado en Vercel Preview y permisos del nuevo registro.
5. Pilotear con número empresarial dedicado, nunca un teléfono de uso mixto hasta validar privacidad y elegibilidad.
6. Luego de las pruebas, pedir autorización antes de `git push` o desplegar.
