/**
 * Script standalone para (re)configurar únicamente el disparador de
 * AWS EventBridge de la Lambda de recordatorios (`communityhub-notifications`),
 * asumiendo que la función ya está desplegada. Crea/actualiza la regla de
 * cron cada 6 horas, la asocia como target y otorga el permiso de invocación.
 * Se ejecuta manualmente con `node setup_eventbridge.js`.
 */
const fs = require('fs');
const path = require('path');
const { LambdaClient, AddPermissionCommand } = require('@aws-sdk/client-lambda');
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand } = require('@aws-sdk/client-eventbridge');

// Ruta al archivo .env del backend, de donde se leen las credenciales de AWS
const envPath = path.resolve(__dirname, '../backend/.env');
const envContent = fs.readFileSync(envPath, 'utf8');

/**
 * Extrae el valor de una variable de entorno desde el contenido crudo de un archivo .env.
 * @param {string} key - Nombre de la variable de entorno a buscar.
 * @returns {string} El valor encontrado, o cadena vacía si no existe.
 */
function getEnvVal(key) {
  const match = envContent.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : '';
}

// Región de AWS a usar (por defecto us-east-2 si no está definida)
const region = getEnvVal('AWS_REGION') || 'us-east-2';
// Credenciales de AWS leídas desde backend/.env
const credentials = {
  accessKeyId: getEnvVal('AWS_ACCESS_KEY_ID'),
  secretAccessKey: getEnvVal('AWS_SECRET_ACCESS_KEY'),
};

// Cliente para operaciones sobre AWS Lambda (otorgar permiso de invocación)
const lambda = new LambdaClient({ region, credentials });
// Cliente para operaciones sobre AWS EventBridge (crear la regla y su target)
const eventbridge = new EventBridgeClient({ region, credentials });

// Nombre de la función Lambda que será disparada por la regla
const FUNCTION_NAME = 'communityhub-notifications';
// Nombre de la regla de EventBridge a crear/actualizar
const RULE_NAME = 'communityhub-reminders-cron';

/**
 * Crea/actualiza la regla de EventBridge (cron cada 6 horas), la asocia como
 * target de la función Lambda, y le otorga permiso de invocación a EventBridge.
 * @returns {Promise<void>}
 */
async function main() {
  console.log('[1/3] Creando regla de programacion en AWS EventBridge...');
  const ruleRes = await eventbridge.send(
    new PutRuleCommand({
      Name: RULE_NAME,
      ScheduleExpression: 'rate(6 hours)',
      State: 'ENABLED',
      Description: 'Cron periodico cada 6 horas para recordatorios de actividades',
    })
  );
  console.log(`Regla creada/actualizada: ${ruleRes.RuleArn}`);

  console.log('[2/3] Asociando la regla como trigger de la funcion Lambda...');
  const lambdaArn = `arn:aws:lambda:${region}:475487646360:function:${FUNCTION_NAME}`;

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
  console.log('Target de EventBridge vinculado correctamente.');

  console.log('[3/3] Asignando permisos de invocacion a EventBridge...');
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        StatementId: 'EventBridgeInvokePermission',
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
        SourceArn: ruleRes.RuleArn,
      })
    );
    console.log('Permiso concedido.');
  } catch (e) {
    if (e.name === 'ResourceConflictException') {
      console.log('El permiso ya estaba asignado.');
    } else {
      console.log('Nota de permiso:', e.message);
    }
  }

  console.log('\n? �EventBridge configurado correctamente como desencadenador cada 6 horas!');
}

// Punto de entrada del script
main().catch(console.error);