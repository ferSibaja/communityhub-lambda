/**
 * Función AWS Lambda de CommunityHub: contiene dos handlers serverless
 * (recordatorios de actividades próximas y reporte periódico de estadísticas)
 * que se conectan directamente a MongoDB usando versiones simplificadas de
 * los modelos del backend, sin depender del código de la API.
 */
const mongoose = require('mongoose');

// Esquema simplificado de Notification: solo los campos que esta Lambda necesita leer/crear
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: false },
    type: {
      type: String,
      enum: ['reminder', 'update', 'cancellation', 'system', 'report'],
      default: 'reminder',
    },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Esquema simplificado de Registration: relaciona un usuario con un evento y su estado de inscripción
const registrationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
    status: { type: String },
  },
  { timestamps: true }
);

// Esquema simplificado de Event: título, categoría, fecha y estado de la actividad
const eventSchema = new mongoose.Schema(
  {
    title: { type: String },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    date: { type: Date },
    status: { type: String },
  },
  { timestamps: true }
);

// Esquema simplificado de User: solo se necesita el rol para contar usuarios/organizadores/administradores
const userSchema = new mongoose.Schema(
  {
    role: { type: String },
  },
  { timestamps: true }
);

// Esquema simplificado de Category: solo el nombre, usado para el reporte de categoría más popular
const categorySchema = new mongoose.Schema({
  name: { type: String },
});

// Modelos Mongoose reutilizando el registro existente si ya fue compilado (evita OverwriteModelError en invocaciones repetidas)
const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
const Registration = mongoose.models.Registration || mongoose.model('Registration', registrationSchema);
const Event = mongoose.models.Event || mongoose.model('Event', eventSchema);
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);

/**
 * Asegura que exista una conexión activa a MongoDB, reutilizando la conexión
 * existente entre invocaciones "calientes" de la Lambda en lugar de abrir una nueva cada vez.
 * @returns {Promise<void>}
 * @throws {Error} Si falta la variable de entorno MONGODB_URI.
 */
async function ensureConnection() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('Falta la variable MONGODB_URI en la configuración de Lambda');
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  }
}

/**
 * Handler principal de la Lambda: busca actividades activas que ocurrirán
 * dentro de las próximas 24 horas y crea una notificación de tipo "reminder"
 * para cada usuario inscrito y confirmado que aún no la haya recibido.
 * Pensada para dispararse periódicamente vía AWS EventBridge.
 * @param {object} event - Evento de invocación de Lambda (no se usa su contenido).
 * @param {object} context - Contexto de ejecución de Lambda.
 * @returns {Promise<{statusCode: number, body: string}>} Respuesta HTTP-like con el resultado del proceso.
 */
exports.handler = async (event, context) => {
  // Evita que Lambda espere a que el event loop esté vacío antes de responder (conexiones de mongoose quedan abiertas)
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureConnection();

    const now = new Date();
    // Límite superior: dentro de las próximas 24 horas desde ahora
    const next24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Actividades activas cuya fecha cae dentro de la ventana de 24 horas
    const upcomingEvents = await Event.find({
      status: 'active',
      date: { $gte: now, $lte: next24Hours },
    });

    // Contador de notificaciones nuevas creadas en esta ejecución
    let notificationsCreated = 0;

    for (const upcomingEvent of upcomingEvents) {
      // Usuarios con inscripción confirmada en esta actividad
      const registrations = await Registration.find({
        event: upcomingEvent._id,
        status: 'confirmed',
      });

      for (const reg of registrations) {
        // Evita duplicar el recordatorio si ya se le notificó a este usuario para esta actividad
        const existingNotif = await Notification.findOne({
          user: reg.user,
          event: upcomingEvent._id,
          type: 'reminder',
        });

        if (!existingNotif) {
          await Notification.create({
            user: reg.user,
            event: upcomingEvent._id,
            type: 'reminder',
            message: `⏰ Recordatorio: La actividad "${upcomingEvent.title}" se llevará a cabo en menos de 24 horas.`,
          });
          notificationsCreated++;
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Procesamiento serverless de recordatorios completado',
        upcomingEventsProcessed: upcomingEvents.length,
        notificationsCreated,
      }),
    };
  } catch (error) {
    console.error('Error en ejecución de AWS Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};

/**
 * Segundo handler de la Lambda: genera un reporte periódico con estadísticas
 * generales de la plataforma (usuarios, actividades, inscripciones, actividad
 * más popular y categoría más usada) y lo entrega como notificación de tipo
 * "report" a cada usuario administrador. Pensado para dispararse una vez al
 * día vía AWS EventBridge, en una regla separada del handler de recordatorios.
 * @param {object} event - Evento de invocación de Lambda (no se usa su contenido).
 * @param {object} context - Contexto de ejecución de Lambda.
 * @returns {Promise<{statusCode: number, body: string}>} Respuesta HTTP-like con el resultado del proceso.
 */
exports.reportHandler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureConnection();

    // Estadísticas generales calculadas en paralelo para minimizar el tiempo de ejecución
    const [
      totalUsers,
      totalOrganizers,
      totalEvents,
      activeEvents,
      finishedEvents,
      totalRegistrations,
      admins,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: 'organizador' }),
      Event.countDocuments({}),
      Event.countDocuments({ status: 'active' }),
      Event.countDocuments({ status: 'finished' }),
      Registration.countDocuments({ status: 'confirmed' }),
      User.find({ role: 'administrador' }, '_id'),
    ]);

    // Actividad con más inscripciones confirmadas (agrupando registros por evento)
    const popularAgg = await Registration.aggregate([
      { $match: { status: 'confirmed' } },
      { $group: { _id: '$event', total: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: 1 },
    ]);
    let mostPopularEvent = null;
    if (popularAgg.length > 0) {
      const ev = await Event.findById(popularAgg[0]._id, 'title');
      mostPopularEvent = ev ? { title: ev.title, registrations: popularAgg[0].total } : null;
    }

    // Categoría con más actividades creadas (agrupando eventos por categoría)
    const categoryAgg = await Event.aggregate([
      { $group: { _id: '$category', total: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: 1 },
    ]);
    let topCategory = null;
    if (categoryAgg.length > 0 && categoryAgg[0]._id) {
      const cat = await Category.findById(categoryAgg[0]._id, 'name');
      topCategory = cat ? { name: cat.name, events: categoryAgg[0].total } : null;
    }

    // Objeto con todas las estadísticas calculadas, incluido en la respuesta de la Lambda
    const stats = {
      totalUsers,
      totalOrganizers,
      totalEvents,
      activeEvents,
      finishedEvents,
      totalRegistrations,
      mostPopularEvent,
      topCategory,
      generatedAt: new Date().toISOString(),
    };

    // Texto legible del reporte que se guarda como mensaje de la notificación
    const summary =
      `📊 Reporte CommunityHub — ${totalUsers} usuarios (${totalOrganizers} organizadores), ` +
      `${totalEvents} actividades (${activeEvents} activas, ${finishedEvents} finalizadas), ` +
      `${totalRegistrations} inscripciones confirmadas.` +
      (mostPopularEvent ? ` Actividad más popular: "${mostPopularEvent.title}".` : '') +
      (topCategory ? ` Categoría más usada: "${topCategory.name}".` : '');

    await Promise.all(
      admins.map((admin) =>
        Notification.create({
          user: admin._id,
          type: 'report',
          message: summary,
        })
      )
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Reporte periódico generado correctamente',
        adminsNotified: admins.length,
        stats,
      }),
    };
  } catch (error) {
    console.error('Error generando el reporte periódico de AWS Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};