/**
 * Script de diagnóstico manual: verifica que las credenciales de AWS
 * configuradas en backend/.env tengan permiso para listar funciones Lambda
 * y roles IAM existentes. Se ejecuta directamente con `node check_aws.js`.
 */
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { IAMClient, ListRolesCommand } = require('@aws-sdk/client-iam');
const fs = require('fs');
const path = require('path');

// Ruta al archivo .env del backend, de donde se leen las credenciales de AWS
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
// Credenciales de AWS leídas desde backend/.env
const credentials = {
  accessKeyId: getEnvVal('AWS_ACCESS_KEY_ID'),
  secretAccessKey: getEnvVal('AWS_SECRET_ACCESS_KEY'),
};

// Cliente para operaciones sobre AWS Lambda
const lambda = new LambdaClient({ region, credentials });
// Cliente para operaciones sobre AWS IAM
const iam = new IAMClient({ region, credentials });

/**
 * Ejecuta las pruebas de conectividad: lista las funciones Lambda existentes
 * y los roles IAM existentes, imprimiendo el resultado o el error en consola.
 * @returns {Promise<void>}
 */
async function check() {
  console.log('--- Probando Lambda: ListFunctions ---');
  try {
    const funcs = await lambda.send(new ListFunctionsCommand({}));
    console.log('Funciones existentes:', funcs.Functions.map(f => ({ name: f.FunctionName, role: f.Role })));
  } catch (e) {
    console.log('Error en ListFunctions:', e.message);
  }

  console.log('--- Probando IAM: ListRoles ---');
  try {
    const roles = await iam.send(new ListRolesCommand({}));
    console.log('Roles existentes:', roles.Roles.map(r => r.Arn));
  } catch (e) {
    console.log('Error en ListRoles:', e.message);
  }
}

// Ejecuta el diagnóstico al correr el script
check();