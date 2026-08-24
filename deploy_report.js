/**
 * Script de despliegue de la segunda función Lambda (reporte periódico de
 * estadísticas, `communityhub-report`): reutiliza el mismo paquete de código
 * (index.js) que la Lambda de recordatorios, pero apuntando al handler
 * `reportHandler` y con su propia regla de EventBridge (una vez al día).
 * Requiere que el rol IAM `communityhub-lambda-role` ya exista (lo crea deploy.js).
 * Se ejecuta manualmente con `node deploy_report.js`.
 */
const fs = require('fs');
const path = require('path');
const {
  IAMClient,
  GetRoleCommand,
} = require('@aws-sdk/client-iam');
const {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionCommand,
  InvokeCommand,
  AddPermissionCommand,
} = require('@aws-sdk/client-lambda');
const {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} = require('@aws-sdk/client-eventbridge');

// Ruta al archivo .env del backend, de donde se leen credenciales de AWS y la URI de Mongo
const envPath = path.resolve(__dirname, '../backend/.env');
const envContent = fs.readFileSync(envPath, 'utf8');

/**
 * Extrae el valor de una variable de entorno desde el contenido crudo de un archivo .env.
 * @param {string} key - Nombre de la variable de entorno a buscar.
 * @returns {string} El valor encontrado, o cadena vacía si no existe.
 */
function getEnvVal(key) {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

// Región de AWS a usar (por defecto us-east-2 si no está definida)
const region = getEnvVal('AWS_REGION') || 'us-east-2';
const accessKeyId = getEnvVal('AWS_ACCESS_KEY_ID');
const secretAccessKey = getEnvVal('AWS_SECRET_ACCESS_KEY');
// URI de conexión a MongoDB que se inyecta como variable de entorno de la Lambda
const mongoUri = getEnvVal('MONGODB_URI');

if (!accessKeyId || !secretAccessKey) {
  console.error('ERROR: Credenciales de AWS no encontradas en backend/.env');
  process.exit(1);
}

// Credenciales de AWS usadas por todos los clientes del SDK en este script
const credentials = { accessKeyId, secretAccessKey };

// Cliente para operaciones sobre AWS IAM (lectura del rol de ejecución existente)
const iam = new IAMClient({ region, credentials });
// Cliente para operaciones sobre AWS Lambda (crear/actualizar la función)
const lambda = new LambdaClient({ region, credentials });
// Cliente para operaciones sobre AWS EventBridge (regla de disparo diario)
const eventbridge = new EventBridgeClient({ region, credentials });

// Nombre de la función Lambda de reportes a desplegar
const FUNCTION_NAME = 'communityhub-report';
// Nombre del rol IAM de ejecución (compartido con la Lambda de recordatorios)
const ROLE_NAME = 'communityhub-lambda-role';
// Nombre de la regla de EventBridge que dispara el reporte una vez al día
const RULE_NAME = 'communityhub-report-cron';

/**
 * Pausa la ejecución del script por la cantidad de milisegundos indicada.
 * @param {number} ms - Milisegundos a esperar.
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Obtiene el ARN del rol IAM de ejecución compartido, asumiendo que ya
 * existe (fue creado previamente por deploy.js).
 * @returns {Promise<string>} El ARN del rol IAM.
 */
async function getRoleArn() {
  const res = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  return res.Role.Arn;
}

/**
 * Crea la función Lambda de reportes si no existe, o actualiza su código y
 * configuración si ya existe, a partir del ZIP generado previamente.
 * @param {string} roleArn - ARN del rol IAM de ejecución a asignar (solo se usa al crear).
 * @returns {Promise<string>} El ARN de la función Lambda desplegada.
 */
async function deployLambda(roleArn) {
  const zipPath = path.resolve(__dirname, 'communityhub-lambda.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Archivo zip no encontrado en ${zipPath}. Ejecuta primero pack_and_upload.js o zipea manualmente.`);
  }
  const zipBuffer = fs.readFileSync(zipPath);

  let functionExists = false;
  let lambdaArn = '';

  try {
    const res = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    functionExists = true;
    lambdaArn = res.Configuration.FunctionArn;
    console.log(`[Lambda] Función ya existe (${lambdaArn}). Actualizando código y configuración...`);
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  // Configuración común de runtime/handler/timeout usada tanto al crear como al actualizar
  const config = {
    FunctionName: FUNCTION_NAME,
    Runtime: 'nodejs20.x',
    Handler: 'index.reportHandler',
    Timeout: 60,
    MemorySize: 256,
    Environment: { Variables: { MONGODB_URI: mongoUri } },
  };

  if (functionExists) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: zipBuffer }));
    console.log('[Lambda] Esperando actualización de código...');
    await sleep(5000);
    const updateConf = await lambda.send(new UpdateFunctionConfigurationCommand(config));
    lambdaArn = updateConf.FunctionArn;
    console.log('[Lambda] Configuración actualizada.');
  } else {
    console.log(`[Lambda] Creando función ${FUNCTION_NAME}...`);
    const createRes = await lambda.send(
      new CreateFunctionCommand({
        ...config,
        Role: roleArn,
        Code: { ZipFile: zipBuffer },
        Description: 'CommunityHub Serverless Periodic Statistics Report',
      })
    );
    lambdaArn = createRes.FunctionArn;
    console.log(`[Lambda] Función creada con éxito: ${lambdaArn}`);
  }

  return lambdaArn;
}

/**
 * Crea/actualiza la regla de EventBridge que dispara la Lambda de reportes
 * una vez al día, la asocia como target y le otorga permiso de invocación.
 * @param {string} lambdaArn - ARN de la función Lambda a la que apuntará la regla.
 * @returns {Promise<void>}
 */
async function setupEventBridge(lambdaArn) {
  console.log(`[EventBridge] Configurando regla ${RULE_NAME}...`);
  const putRuleRes = await eventbridge.send(
    new PutRuleCommand({
      Name: RULE_NAME,
      ScheduleExpression: 'rate(1 day)',
      State: 'ENABLED',
      Description: 'Disparador diario para el reporte de estadísticas de CommunityHub',
    })
  );

  await eventbridge.send(
    new PutTargetsCommand({
      Rule: RULE_NAME,
      Targets: [{ Id: 'CommunityHubReportTarget', Arn: lambdaArn }],
    })
  );
  console.log('[EventBridge] Target asociado a la regla.');

  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        StatementId: 'EventBridgeInvokePermission',
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
        SourceArn: putRuleRes.RuleArn,
      })
    );
    console.log('[Lambda] Permiso para EventBridge concedido.');
  } catch (err) {
    if (err.name === 'ResourceConflictException') {
      console.log('[Lambda] El permiso para EventBridge ya existía.');
    } else {
      console.warn('[Lambda] Nota sobre permisos:', err.message);
    }
  }
}

/**
 * Invoca la función Lambda de reportes ya desplegada con un payload vacío,
 * para comprobar que se ejecuta correctamente en AWS, e imprime la respuesta.
 * @returns {Promise<void>}
 */
async function testInvocation() {
  console.log('\n[Test] Invocando la función de reporte para probar ejecución real...');
  const invokeRes = await lambda.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({})),
    })
  );
  const payloadString = Buffer.from(invokeRes.Payload).toString('utf8');
  console.log(`[Test] Status Code HTTP: ${invokeRes.StatusCode}`);
  console.log(`[Test] Respuesta de la Lambda:\n${payloadString}`);
}

/**
 * Orquesta el despliegue completo del reporte: obtiene el rol IAM
 * compartido, despliega la función Lambda, configura EventBridge y hace
 * una invocación de prueba.
 * @returns {Promise<void>}
 */
async function main() {
  try {
    console.log('=== Despliegue de AWS Lambda: reporte periódico de estadísticas ===');
    console.log(`Región: ${region}`);
    const roleArn = await getRoleArn();
    const lambdaArn = await deployLambda(roleArn);
    await setupEventBridge(lambdaArn);
    await testInvocation();
    console.log('\n[OK] Despliegue del reporte completado con éxito en AWS!');
  } catch (error) {
    console.error('\n[ERROR] Error durante el despliegue:', error);
    process.exit(1);
  }
}

// Punto de entrada del script de despliegue
main();
