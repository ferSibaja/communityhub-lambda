/**
 * Script rápido de empaquetado y subida directa: genera el ZIP de la Lambda
 * de recordatorios en memoria (código + node_modules) y lo sube directamente
 * a la función ya existente en AWS con UpdateFunctionCodeCommand, sin pasar
 * por la creación de rol/función/EventBridge (a diferencia de deploy.js).
 * Útil para iterar rápido tras un cambio en index.js. Se ejecuta con `node pack_and_upload.js`.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { LambdaClient, UpdateFunctionCodeCommand, InvokeCommand } = require('@aws-sdk/client-lambda');

console.log('[1/3] Empaquetando la Lambda con adm-zip...');
// Paquete ZIP en memoria con el código fuente y sus dependencias
const zip = new AdmZip();

zip.addLocalFile(path.join(__dirname, 'index.js'));
zip.addLocalFile(path.join(__dirname, 'package.json'));
zip.addLocalFolder(path.join(__dirname, 'node_modules'), 'node_modules');

// Buffer final del ZIP, listo para subirse a AWS Lambda
const zipBuffer = zip.toBuffer();
console.log(`[2/3] Paquete ZIP generado en memoria: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);

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

// Cliente para operaciones sobre AWS Lambda
const lambda = new LambdaClient({ region, credentials });

/**
 * Sube el ZIP generado a la función Lambda existente y la invoca una vez
 * para verificar que la actualización de código se ejecuta correctamente.
 * @returns {Promise<void>}
 */
async function run() {
  console.log('[3/3] Subiendo el paquete directamente a la funcion AWS Lambda...');
  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: 'communityhub-notifications',
      ZipFile: zipBuffer,
    })
  );
  console.log('? �Codigo de Lambda cargado con exito en AWS!');

  console.log('Esperando 5 segundos para probar la ejecucion...');
  await new Promise((r) => setTimeout(r, 5000));

  console.log('?? Ejecutando prueba real de la Lambda en AWS...');
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: 'communityhub-notifications',
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({})),
    })
  );

  const resultStr = Buffer.from(res.Payload).toString('utf8');
  console.log('HTTP Status Code:', res.StatusCode);
  console.log('Respuesta de la Lambda:\n', resultStr);
}

// Punto de entrada del script
run().catch(console.error);
