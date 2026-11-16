# Etapa 2 — Presupuestos y rendimiento publicitario

## Arquitectura

- Se mantienen exactamente tres funciones Vercel: `api/index.js`, `api/upload.js` y `api/waWebhook.js`.
- Las acciones nuevas (`economics` y `marketing_dashboard`) usan `/api/crmManagement`, que ya se enruta por `api/index.js`.
- El token de Meta se usa solo en backend y se envía a Graph API en el header `Authorization`.
- La integración es de solo lectura. No existen endpoints para crear, pausar, activar, modificar o eliminar campañas.
- Firestore `(default)` fue identificado como `STANDARD / FIRESTORE_NATIVE`.

## Variables de entorno de Vercel (backend)

Obligatorias para conectar Meta:

- `META_MARKETING_ACCESS_TOKEN`: token con permiso `ads_read` y acceso efectivo a las cuentas consultadas.
- `META_GRAPH_API_VERSION`: versión habilitada para la app, con formato `vN.N`. No se fija una versión por defecto para evitar actualizar silenciosamente una integración incompatible.

Opcionales:

- `META_AD_ACCOUNT_IDS`: IDs numéricos separados por coma, con o sin prefijo `act_`. Si se omite, se consulta `/me/adaccounts`.
- `META_CACHE_TTL_SECONDS`: duración de caché en memoria, entre 60 y 1800 segundos. Valor por defecto: `300`.

Se conservan las variables existentes, entre ellas `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_STORAGE_BUCKET`, `CRM_ADMIN_EMAILS` y `CORS_ORIGIN`. No se agrega ningún secreto al frontend.

## Modelo Firestore incorporado

Los campos son opcionales y se agregan por `merge` en `conversations/{conversationId}`:

- `crmQuoteAmount`: number no negativo, máximo `999999999999.99`.
- `crmQuoteCurrency`: `ARS`.
- `crmQuoteAt`: timestamp.
- `crmQuoteSellerUid`, `crmQuoteSellerEmail`, `crmQuoteSellerName`: responsable asignado al momento de guardar.
- `crmConfirmedRevenueAmount`: number no negativo, independiente del presupuesto y del estado `Vendido`.
- `crmConfirmedRevenueCurrency`: `ARS`.
- `crmConfirmedRevenueAt`: timestamp.
- `crmConfirmedRevenueByUid`, `crmConfirmedRevenueByEmail`: administrador que confirmó el importe.
- `crmEconomicVersion`: entero usado para control optimista de concurrencia.

Cada cambio genera un documento inmutable de auditoría en `gestionEventos` con uno de estos tipos:

- `quote_updated`
- `quote_cleared`
- `confirmed_revenue_updated`
- `confirmed_revenue_cleared`

No se requiere migración masiva: la ausencia de campos representa “sin dato”. No se convierten datos faltantes en cero.

## Permisos

- Presupuesto: administrador o vendedor actualmente asignado al contacto.
- Facturación confirmada: solo administrador.
- Marketing API y rendimiento agregado: solo administrador.
- Todas las decisiones se validan en backend con Firebase ID Token. El frontend no es una frontera de seguridad.
- Las escrituras usan Firebase Admin SDK desde el backend; no se debilitan ni se modifican reglas de Firestore.

## Atribución y fórmulas

Un lead solo se atribuye cuando el `source_id` del primer referral histórico de WhatsApp coincide exactamente con un ID de anuncio devuelto por Meta. `headline`, texto, URL y nombres no se usan como coincidencia. Sin evidencia exacta queda en `Sin identificar`; no se etiqueta automáticamente como orgánico.

- Lead real: teléfono único en el conjunto filtrado.
- Recurrente: teléfono con más de una conversación o más de un ingreso registrado.
- CPL real: inversión del filtro / leads únicos atribuibles.
- CPL calificado: inversión / leads atribuibles calificados.
- Tasa de calificación: calificados / (calificados + no calificados).
- Conversión: vendidos y calificados / leads calificados.
- Ticket promedio: facturación confirmada / contactos con importe confirmado, solo cuando existe una única moneda de facturación.
- ROAS: facturación confirmada atribuible / inversión, únicamente con la misma moneda.

Cuando hay varias monedas no se suman. Se muestran subtotales por moneda y los ratios monetarios quedan como no disponibles.

## Fechas

- Leads: `firstInboundAt` del primer registro del teléfono, inicio inclusivo y fin exclusivo.
- Inversión: `date_start` de Meta, usando la zona horaria de la cuenta; `time_range.until` es inclusivo.
- El rango publicitario máximo por consulta es de 367 días para proteger la función Hobby.

## Índices

No se incorporan consultas Firestore compuestas nuevas. Se reutilizan lecturas existentes de `conversations`, `wabaNumbers` y `gestionEventos`; por lo tanto esta etapa no requiere un índice compuesto adicional.

## Comandos de verificación local

Backend:

```powershell
cd C:\Users\feder\Desktop\programacion\crm\crmbackend-master
npm test
node --check lib\crmManagement.js
node --check lib\marketingAnalytics.js
node --check lib\metaMarketing.js
node --check api\waWebhook.js
node --check handlers\inventory.js
node --check handlers\sendMessage.js
```

Frontend:

```powershell
cd C:\Users\feder\Desktop\programacion\crm\crmforntend-master
npm run build
npx eslint src\components\crm\MarketingPerformancePanel.jsx src\components\crm\CrmContactDetail.jsx src\components\crm\AdminCrmManagement.jsx src\components\crm\CrmExcelInsights.jsx src\lib\crmManagement.js src\services\crmManagement.js
```

Confirmar edición Firestore, sin desplegar:

```powershell
npx -y firebase-tools@latest firestore:databases:list --project crmsistem-d3009
```

## Pendiente de credenciales

Sin las variables Meta, la aplicación muestra el estado “integración lista pero sin conexión”. Presupuestos, facturación confirmada y estadísticas CRM funcionan igualmente. La llamada real a Meta, la validación del alcance efectivo del token y la comparación con datos productivos quedan pendientes hasta configurar credenciales. No se realizó ningún despliegue.
