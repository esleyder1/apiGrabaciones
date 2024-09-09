const express = require('express');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');
const { spawn } = require('child_process');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const https = require('https');
const WebSocket = require('ws');
const progressStream = require('progress-stream');
const path = require('path');

const app = express();
const port = 3000;

const tlsCertFile = fs.readFileSync('/etc/ssl/certs/apache2-AsterVoIP.crt', 'utf8');
const tlsPrivateKey = fs.readFileSync('/etc/ssl/private/apache2-AsterVoIP.key', 'utf8');
const credentials = { cert: tlsCertFile, key: tlsPrivateKey };

// Configurar servidor HTTPS
const httpsServer = https.createServer(credentials, app);

// Configurar WebSocket Server
const wss = new WebSocket.Server({ server: httpsServer });

// Manejar conexiones WebSocket
wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
  });
});

const authToken = 'dev';
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${authToken}`) {
        return res.status(401).send('Acceso no autorizado');
    }
    next();
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/get-all-recordings', verifyToken, async (req, res) => {
    try {
        const recordingsDir = '/data/monitor/';
        const files = fs.readdirSync(recordingsDir);

        const recordings = files.filter(file => path.extname(file) === '.wav').map(file => {
            return {
                name: file,
                path: path.join(recordingsDir, file)
            };
        });

        res.json(recordings);
    } catch (error) {
        console.error('Error al obtener las grabaciones:', error);
        return res.status(500).send('Error interno del servidor');
    }
});

app.post("/get-recording-details/", verifyToken, async (req, res) => {
  let recordingName = req.body.recordingName;
  console.log("'" + recordingName + "'");
  if (!recordingName) {
    return res.status(400).send("El nombre de la grabaci  n es obligatorio");
  }
recordingName = recordingName.replace(/\\ /g, ' ');


        // Unir las partes del camino y normalizarlo
const recordingPath = path.normalize(path.join('/data/monitor/', recordingName));

  if (!fs.existsSync(recordingPath)) {
    return res.status(404).send("Grabación no encontrada");
  } else {
    return res.status(200).send("Grabación encontrada");
  }
});

app.delete("/delete-recording/:recordingName", verifyToken, (req, res) => {
  let recordingName = req.params.recordingName;

  if (!recordingName) {
    return res.status(400).send("El nombre de la grabación es obligatorio");
  }

  recordingName = recordingName.replace(/\\ /g, ' ');
  const recordingPath = path.normalize(path.join('/data/monitor/', recordingName));

  if (!fs.existsSync(recordingPath)) {
    return res.status(404).json({ status: 404, message: "Grabación no encontrada" });
  }

  try {
    fs.unlinkSync(recordingPath);  // Elimina el archivo del sistema de archivos local
    res.status(200).json({ status: 200, message: `La grabación ${recordingName} ha sido eliminada exitosamente` });
  } catch (error) {
    console.error(`Error al eliminar la grabación ${recordingName}:`, error);
    return res.status(500).json({ status: 500, message: "Error interno del servidor" });
  }
});

app.post('/get-recording', verifyToken, async (req, res) => {
    let recordingName = req.body.recordingName;
    console.log("'" + recordingName + "'");

    if (!recordingName) {
        return res.status(400).send('El nombre de la grabación es obligatorio');
    }

    // Agregar una barra inclinada al nombre del archivo si no está presente
recordingName = recordingName.replace(/\\ /g, ' ');


	// Unir las partes del camino y normalizarlo
const recordingPath = path.normalize(path.join('/data/monitor/', recordingName));
console.log('Recording path:', recordingPath);

if (!fs.existsSync(recordingPath)) {
    return res.status(404).send('Grabación no encontrada');
} else {
    console.log("Archivo encontrado:", recordingPath);

    try {
        // Crear un nombre de archivo temporal
        const tempFilePath = `temp_${path.basename(recordingName, '.WAV')}.wav`;

        // Leer el archivo y guardarlo temporalmente
        const audioBuffer = fs.readFileSync(recordingPath);
        fs.writeFileSync(tempFilePath, audioBuffer);

        // Usar SoX para convertir el archivo WAV a OGG y enviar la respuesta
        const soxProcess = spawn('sox', [
            tempFilePath, // Archivo de entrada WAV
            '-t', 'ogg',  // Formato de salida OGG
            '-'           // Salida a la tubería estándar
        ]);

        soxProcess.stderr.on('data', (data) => {
            console.error(`Error en SoX: ${data}`);
        });

        res.set('Content-Type', 'audio/ogg');
        soxProcess.stdout.pipe(res);

        soxProcess.on('exit', () => {
            fs.unlinkSync(tempFilePath);
        });


    } catch (error) {
        console.error(`Error al procesar la grabación: ${error}`);
        return res.status(500).send('Error interno del servidor');
    }
  }
});

app.post("/get-recordings-zip", verifyToken, async (req, res) => {
  const recordingNames = req.body.recordingNames;

  if (!recordingNames || !Array.isArray(recordingNames) || recordingNames.length === 0) {
    return res.status(400).send("Los nombres de las grabaciones son obligatorios y deben ser un array");
  }

  try {
    const zipFilePath = "recordings.zip";
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    let totalSize = 0;

    for (const recordingName of recordingNames) {
      const recordingPath = path.normalize(path.join('/data/monitor/', recordingName));

      if (fs.existsSync(recordingPath)) {
        const stats = fs.statSync(recordingPath);
        totalSize += stats.size;
      } else {
        console.error(`Grabación no encontrada: ${recordingName}`);
      }
    }

    // Crear un stream de progreso para el archivo zip
    const progress = progressStream({ length: totalSize });
    progress.on("progress", (progressData) => {
      // Enviar el progreso a través de WebSocket a tu cliente
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "progress", data: progressData }));
        }
      });
    });

    output.on("close", () => {
      res.set("Content-Type", "application/zip");
      res.download(zipFilePath, "recordings.zip", () => {
        fs.unlinkSync(zipFilePath);
      });
    });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(progress).pipe(output);

    for (const recordingName of recordingNames) {
      const recordingPath = path.normalize(path.join('/data/monitor/', recordingName));

      if (fs.existsSync(recordingPath)) {
        archive.file(recordingPath, { name: recordingName });
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error("Error al generar el archivo ZIP:", error);
    return res.status(500).send("Error interno del servidor");
  }
});

httpsServer.listen(port, () => {
    console.log(`Servidor HTTPS escuchando en el puerto ${port}`);
});