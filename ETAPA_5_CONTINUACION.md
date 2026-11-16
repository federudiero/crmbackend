# CRMSISTEM — Etapa 5 (continuación después del límite de Codex)

## Origen y alcance

Se trabajó **sobre los ZIP adjuntos** `crmbackend-master (5).zip` y `crmforntend-master (4).zip`, que ya contenían cambios parciales de Codex en Marketing API y dashboard. No se sustituyeron los módulos del CRM ni se habilitó WhatsApp.

### Cambios de esta continuación

- `backend/lib/metaMarketing.js`: protección adicional ante cursores repetidos en la paginación Graph.
- `backend/lib/marketingAnalytics.js`: evitar sumar el alcance único por anuncio; conservar `null` donde un total de reach sería engañoso; distinguir oportunidades del mismo teléfono recibidas en **diferentes números empresariales**; corregir costo por venta atribuida sin exigir facturación cargada; coherencia de ventas con `crmOutcome === "Vendido" || sold === true`; ficha del contacto con ID actual.
- `frontend/src/components/crm/MarketingPerformancePanel.jsx`: ranking utilizable de campañas; ampliación de detalle de anuncio con inversión, impresiones, clics, CTR, CPC, CPM, Meta results, leads, calificados, formularios, ventas, CPL y acceso a fichas; tabla explícita de contactos atribuidos.
- `backend/testing/marketingAnalytics.test.js`: cuatro tests nuevos para alcance único, separación de números empresariales, costo por venta y detalle por anuncio.

### Funcionalidad que **ya venía** en los ZIP de Codex (no implementada desde cero en esta continuación)

- Obtención de campañas, conjuntos, anuncios, insights a nivel de anuncio, presupuestos, CPC/CPM y acciones Meta.
- Agregación de chatbot, transferencias y primeras respuestas humanas.
- Filtros, ROAS, facturación atribuida, permisos administrativos, monedas separadas.

## Pruebas ejecutadas aquí

- Backend: `npm test` -> **70/70 aprobados**.
- Frontend unitario: `node --test tests/chatbotEditor.test.js` -> **6/6 aprobados**.
- Frontend componente MarketingPerformancePanel: ESLint dirigido -> **0 errores**.
- Sintaxis JSX del componente mediante `@babel/parser` -> correcta.
- `node --check` en archivos JavaScript backend modificados -> correcto.
- Build Vite: **no ejecutable en este Linux con los node_modules incluidos en los ZIP de Windows**, por dependencia binaria nativa Rollup para `linux-x64`. No se afirma build aprobado. Ejecutar `npm ci` para la plataforma actual antes de ejecutar build en un entorno limpio, o ejecutar build local con dependencias Windows originales.
- No hay validación visual nueva ni conexión real a Meta.

## Pendientes de la Etapa 5

1. Ejecutar build y pruebas visuales desktop/mobile con un entorno compatible.
2. Verificar el acceso `ads_read`, la cuenta publicitaria, token y versión Graph en Meta Developers.
3. Probar integración real con permisos y cuentas autorizadas: paginación, rate limits, datos incompletos y coherencia de fechas/moneda.
4. Corroborar los nombres de campos y valores de `chatbotFormCompleted`, `chatbotTransferredAt`, `firstSellerResponseAt`, `crmOutcome`, `crmConfirmedRevenueAmount` en los documentos productivos de Firestore.
5. Verificar que el límite de `loadAccessibleRows` no trunque métricas. El panel muestra advertencia de cobertura cuando aplica.
6. Validar de extremo a extremo la apertura de la ficha desde el detalle atribuido.
7. Evaluar si se necesita alcance único *real* de Meta mediante consulta agregada, en lugar de sumar reach de anuncios.
8. Meta Marketing API sigue separada de la habilitación de coexistencia WhatsApp.

## Despliegue y reversión

NO se realizaron operaciones sobre Git, Vercel, Firebase, Meta ni WhatsApp. Se entregan archivos listos para inspección; no hacer deploy sin comparar con el estado actual de los repositorios, completar build y probar con datos de prueba. La reversión consiste en restaurar los cuatro módulos y el test desde la versión anterior; no hay migraciones de base de datos asociadas a esta continuación.

## Seguridad de los entregables

Los paquetes de código fuente excluyen deliberadamente `.git`, `node_modules`, `.env*`, `serviceAccountKey.json`, capturas, builds y otros archivos no necesarios. El ZIP de cambios incluye solo los cuatro módulos afectados, el test y esta documentación. Ningún token debe copiarse al frontend.
