# Módulo AWS Lambda - Procesamiento Serverless de CommunityHub

Este módulo contiene **dos** funciones serverless de **AWS Lambda** requeridas para la plataforma **CommunityHub**, desplegadas y programadas de forma independiente con **AWS EventBridge**.

## Justificación Arquitectónica

En lugar de recargar el servidor Express con tareas cron en segundo plano que bloqueen el hilo de ejecución principal, la arquitectura delega el procesamiento periódico a AWS Lambda:

1. **`handler`** — genera **recordatorios** de actividades próximas (≤ 24h).
2. **`reportHandler`** — genera un **reporte periódico de estadísticas** de la plataforma.

### Flujo de Arquitectura

```
  AWS EventBridge (rate: 6h)              AWS EventBridge (rate: 1 día)
             │                                        │
             ▼                                        ▼
   Lambda: index.handler                  Lambda: index.reportHandler
             │                                        │
             ▼                                        ▼
       MongoDB (MONGODB_URI)                    MongoDB (MONGODB_URI)
  eventos <24h → crea recordatorios      cuenta usuarios/eventos/inscripciones,
  para usuarios inscritos                actividad más popular, categoría top
             │                                        │
             ▼                                        ▼
     Notificación type "reminder"          Notificación type "report" (a admins)
```

## Configuración y Despliegue

1. **Runtime**: Node.js 20.x.
2. **Handlers**: `index.handler` (recordatorios) e `index.reportHandler` (reporte).
3. **Variables de Entorno en AWS Lambda** (ambas funciones):
   - `MONGODB_URI`: String de conexión a MongoDB Atlas.
4. **Triggers** (EventBridge):
   - `communityhub-reminders-cron`: `rate(6 hours)`.
   - `communityhub-report-cron`: `rate(1 day)`.
5. **Scripts** (ver `package.json`):
   ```
   npm run pack          # empaqueta index.js + node_modules y sube el código
   npm run deploy        # crea/actualiza communityhub-notifications + su cron
   npm run deploy:report # crea/actualiza communityhub-report + su cron
   npm run check-aws     # valida credenciales/config de AWS
   ```

Ver [`docs/LAMBDA.md`](../docs/LAMBDA.md) para el detalle de cada función.