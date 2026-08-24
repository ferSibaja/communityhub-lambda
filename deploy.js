/**
 * Script de despliegue de la función Lambda de recordatorios
 * (`communityhub-notifications`): crea el rol IAM si no existe, crea o
 * actualiza la función Lambda con el código empaquetado, configura la regla
 * de AWS EventBridge que la dispara cada 6 horas, y hace una invocación de
 * prueba. Se ejecuta manualmente con `node deploy.js`.
 */
const fs = require('fs');
const path = require('path');
const {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  AttachRolePolicyCommand,
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

// Cliente para operaciones sobre AWS IAM (creación del rol de ejecución)
const iam = new IAMClient({ region, credentials });
// Cliente para operaciones sobre AWS Lambda (crear/actualizar la función)
const lambda = new LambdaClient({ region, credentials });
// Cliente para operaciones sobre AWS EventBridge (regla de disparo periódico)
const eventbridge = new EventBridgeClient({ region, credentials });

// Nombre de la función Lambda a desplegar
const FUNCTION_NAME = 'communityhub-notifications';
// Nombre del rol IAM de ejecución que usará la función
const ROLE_NAME = 'communityhub-lambda-role';
// Nombre de la regla de EventBridge que dispara la función periódicamente
const RULE_NAME = 'communityhub-reminders-cron';

/**
 * Pausa la ejecución del script por la cantidad de milisegundos indicada.
 * Se usa para esperar la propagación de recursos de AWS (roles, código, etc.).
 * @param {number} ms - Milisegundos a esperar.
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Obtiene el rol IAM de ejecución si ya existe, o lo crea con la política de
 * confianza para Lambda y el permiso básico de ejecución si no existe.
 * @returns {Promise<string>} El ARN del rol IAM.
 */
async function getOrCreateRole() {
  console.log(`[IAM] Verificando rol ${ROLE_NAME}...`);
  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    console.log(`[IAM] Rol existente: ${res.Role.Arn}`);
    return res.Role.Arn;
  } catch (err) {
    if (err.name === 'NoSuchEntityException' || err.name === 'NoSuchEntity') {
      console.log(`[IAM] Creando rol ${ROLE_NAME}...`);
      const assumeRolePolicyDocument = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      });

      const createRes = await iam.send(
        new CreateRoleCommand({
          RoleName: ROLE_NAME,
          AssumeRolePolicyDocument: assumeRolePolicyDocument,
          Description: 'Execution role for CommunityHub Lambda',
        })
      );

      console.log(`[IAM] Adjuntando politica basica de ejecucion...`);
      await iam.send(
        new AttachRolePolicyCommand({
          RoleName: ROLE_NAME,
          PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        })
      );

      console.log(`[IAM] Esperando 10 segundos para propagacion del rol en AWS...`);
      await sleep(10000);
      return createRes.Role.Arn;
    }
    throw err;
  }
}

/**
 * Crea la función Lambda si no existe, o actualiza su código y configuración
 * si ya existe, a partir del ZIP generado previamente (communityhub-lambda.zip).
 * @param {string} roleArn - ARN del rol IAM de ejecución a asignar (solo se usa al crear).
 * @returns {Promise<string>} El ARN de la función Lambda desplegada.
 */
async function deployLambda(roleArn) {
  const zipPath = path.resolve(__dirname, 'communityhub-lambda.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Archivo zip no encontrado en ${zipPath}`);
  }
  const zipBuffer = fs.readFileSync(zipPath);

  console.log(`[Lambda] Verificando funcion ${FUNCTION_NAME}...`);
  let functionExists = false;
  let lambdaArn = '';

  try {
    const res = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    functionExists = true;
    lambdaArn = res.Configuration.FunctionArn;
    console.log(`[Lambda] Funcion ya existe (${lambdaArn}). Actualizando codigo y configuracion...`);
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  if (functionExists) {
    await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: FUNCTION_NAME,
        ZipFile: zipBuffer,
      })
    );
    console.log(`[Lambda] Esperando actualizacion de codigo...`);
    await sleep(5000);

    const updateConf = await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Timeout: 60,
        MemorySize: 256,
        Environment: {
          Variables: {
            MONGODB_URI: mongoUri,
          },
        },
      })
    );
    lambdaArn = updateConf.FunctionArn;
    console.log(`[Lambda] Configuracion actualizada.`);
  } else {
    console.log(`[Lambda] Creando funcion ${FUNCTION_NAME}...`);
    let created = false;
    let attempts = 0;
    while (!created && attempts < 5) {
      try {
        attempts++;
        const createRes = await lambda.send(
          new CreateFunctionCommand({
            FunctionName: FUNCTION_NAME,
            Runtime: 'nodejs20.x',
            Role: roleArn,
            Handler: 'index.handler',
            Code: { ZipFile: zipBuffer },
            Description: 'CommunityHub Serverless Notifications and Reminders',
            Timeout: 60,
            MemorySize: 256,
            Environment: {
              Variables: {
                MONGODB_URI: mongoUri,
              },
            },
          })
        );
        lambdaArn = createRes.FunctionArn;
        created = true;
        console.log(`[Lambda] Funcion creada con exito: ${lambdaArn}`);
      } catch (err) {
        if (err.message && err.message.includes('The role defined for the function cannot be assumed')) {
          console.log(`[Lambda] Esperando propagacion del rol (intento ${attempts}/5)...`);
          await sleep(6000);
        } else {
          throw err;
        }
      }
    }
  }

  return lambdaArn;
}

/**
 * Crea/actualiza la regla de EventBridge que dispara la Lambda cada 6 horas,
 * la asocia como target y le otorga permiso de invocación a EventBridge.
 * @param {string} lambdaArn - ARN de la función Lambda a la que apuntará la regla.
 * @returns {Promise<void>}
 */
async function setupEventBridge(lambdaArn) {
  console.log(`[EventBridge] Configurando regla ${RULE_NAME}...`);
  const putRuleRes = await eventbridge.send(
    new PutRuleCommand({
      Name: RULE_NAME,
      ScheduleExpression: 'rate(6 hours)',
      State: 'ENABLED',
      Description: 'Disparador periodico cada 6 horas para recordatorios de CommunityHub',
    })
  );

  console.log(`[EventBridge] Regla creada/actualizada: ${putRuleRes.RuleArn}`);

  await eventbridge.send(
    new PutTargetsCommand({
      Rule: RULE_NAME,
      Targets: [
        {
          Id: 'CommunityHubLambdaTarget',
          Arn: lambdaArn,
        },
      ],
    })
  );
  console.log(`[EventBridge] Target asociado a la regla.`);

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
    console.log(`[Lambda] Permiso para EventBridge concedido.`);
  } catch (err) {
    if (err.name === 'ResourceConflictException') {
      console.log(`[Lambda] El permiso para EventBridge ya existia.`);
    } else {
      console.warn(`[Lambda] Nota sobre permisos:`, err.message);
    }
  }
}

/**
 * Invoca la función Lambda ya desplegada con un payload vacío, para
 * comprobar que se ejecuta correctamente en AWS, e imprime la respuesta.
 * @returns {Promise<void>}
 */
async function testInvocation() {
  console.log(`\n[Test] Invocando funcion Lambda para probar ejecucion real...`);
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
 * Orquesta el despliegue completo: obtiene/crea el rol IAM, despliega la
 * función Lambda, configura EventBridge y hace una invocación de prueba.
 * @returns {Promise<void>}
 */
async function main() {
  try {
    console.log(`=== Despliegue de AWS Lambda CommunityHub ===`);
    console.log(`Region: ${region}`);
    const roleArn = await getOrCreateRole();
    const lambdaArn = await deployLambda(roleArn);
    await setupEventBridge(lambdaArn);
    await testInvocation();
    console.log(`\n[OK] Despliegue completado con exito en AWS!`);
  } catch (error) {
    console.error(`\n[ERROR] Error durante el despliegue:`, error);
    process.exit(1);
  }
}

// Punto de entrada del script de despliegue
main();
