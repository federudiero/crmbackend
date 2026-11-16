# Primera etapa — Adaptación del CRM al Excel de consultas

Base: `crm_frontend_3_modulos.zip` y `crmbackend_hobby_3_funciones.zip` entregados anteriormente. **Estos archivos no están desplegados automáticamente**. No se modificó la planilla fuente.

## Qué se implementó

1. **Ficha del contacto** (admin y vendedor asignado): nuevos campos `crmCustomerZone`, `crmQualification`, `crmUnqualifiedReason`, `crmStage`, `crmOutcome`, `crmOutcomeReason` de la hoja `SEGUIMIENTO`; listas tomadas de la hoja `LISTAS` solo como opciones. La zona es real/declarada por el cliente y no deriva del WABA. Permite elegir localidades del Excel o escribir otras. Los datos históricos siguen sin clasificar hasta que un usuario los complete.
2. **Persistencia**: acción `classification` en `/api/crmManagement`, con validación en servidor, comprobación de permisos, transacción Firestore y auditoría `classification_changed` en `gestionEventos`. No cambia `gestionStatus`, `sold`, mensajes, seguimientos ni inventario.
3. **Estadísticas**: calificación, resultados, embudo por etapa alcanzada (acumulativo), motivos de no calificado y de perdido/congelado. Nueva tabla **Consultas por zona del cliente**: teléfonos únicos y conversaciones; paginación de teléfonos y enlace a ficha. Si un teléfono figura en varias localidades, se cuenta en **Zona por revisar** en lugar de doble conteo. Los teléfonos sin localidad quedan en **Sin identificar**. Los registros sin teléfono no aportan a teléfonos únicos.
4. **Filtros**: localidad del cliente, calificación y resultado de Excel, sin quitar filtros preexistentes.
5. **Dashboard general**: cuatro KPI complementarios de calificación y zonas, conservando inventario.
6. **Tests**: `backend/testing/crmExcelAnalytics.test.js` (cuatro casos independientes de Firebase).

## Archivos frontend afectados

- `src/components/crm/CrmContactDetail.jsx`
- `src/components/crm/AdminCrmManagement.jsx`
- `src/components/crm/CrmExcelInsights.jsx` **nuevo**
- `src/components/admin/ExecutiveDashboard.jsx`
- `src/services/crmManagement.js`
- `src/lib/crmClassification.js` **nuevo**

## Archivos backend afectados

- `lib/crmManagement.js`
- `lib/crmExcelAnalytics.js` **nuevo**
- `testing/crmExcelAnalytics.test.js` **nuevo**

Las tres funciones públicas de `api/` (`index.js`, `upload.js`, `waWebhook.js`) y `vercel.json` se conservan. **No hay nueva función serverless.**

## Instalación segura

1. Hacé copia/commit de las versiones que están en producción.
2. Copiá los archivos desde estos ZIP a los **proyectos correspondientes**, respetando rutas y sin conservar el directorio contenedor si tu repositorio ya representa la raíz. No mezcles la carpeta `frontend` dentro de `frontend`.
3. Verificá que `backend/api/` siga teniendo solo 3 `.js`; `handlers/` y las reglas de rewrite deben seguir presentes.
4. Desplegá **backend primero**, comprobá en Vercel que figure `Ready`; probá `/api/crmManagement` (`GET` y preflight OPTIONS desde el dominio real), luego desplegá el frontend.
5. Verificá autenticación en Firebase y que usuarios que no están asignados no puedan cambiar un contacto.
6. Como pruebas funcionales, seleccioná un contacto, guardá `Alta Gracia` + `Calificado` + `Presupuesto enviado` + `Activo`; recargá, comprobá auditoría, filtrá por localidad; luego probá dos conversaciones del mismo teléfono con localidad coincidente/contradictoria.
7. Revisá que `/api/waWebhook`, envíos de mensajes, carga de archivos e inventario no hayan cambiado.

## Límites y pendientes

- La clasificación y los indicadores económicos del Excel (presupuesto en ARS, inversión, ROAS, ticket, CPA) todavía no se incorporaron: hace falta acordar la fuente de facturación y conectar Marketing API para inversión real. No se inventan ventas a partir de la etiqueta `Vendido`.
- El reporte usa el alcance del dashboard CRM: para admin se leen hasta 25.000 conversaciones (marcadas `conversationsTruncated` si el límite se alcanza). La lista del panel general sigue limitándose a 500, pero el modal geográfico usa una acción paginada independiente.
- Esta entrega pasó pruebas unitarias del módulo de analítica y análisis sintáctico de componentes; **no se pudo ejecutar el build completo ni la integración Firebase porque las dependencias no están disponibles en el entorno de entrega**.
- Al desplegar, verificar reglas y roles reales, y no compartir tokens Meta ni claves Firebase.
