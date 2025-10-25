// Load environment variables from server/.env regardless of CWD
const path = require('path')
// Primary: server/.env
const serverEnvPath = path.resolve(__dirname, '.env')
require('dotenv').config({ path: serverEnvPath })
// Fallback: project root .env (useful if you placed it at repo root)
const rootEnvPath = path.resolve(process.cwd(), '.env')
if (rootEnvPath !== serverEnvPath) {
  require('dotenv').config({ path: rootEnvPath, override: false })
}

const express = require('express')
const app = express()
const dbConfig = require('./config/dbConfig')
const userRoutes = require('./routes/userRoutes')
const whatsappRoutes = require('./routes/whatsappRoutes')
const formsRoutes = require('./routes/formsRoutes')
const branchRoutes = require('./routes/branchRoutes')
const stocksRoutes = require('./routes/stocksRoutes')
const announcementRoutes = require('./routes/announcementRoutes')
const cors = require('cors')


// CORS configuration via env
const rawOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
const corsCredentials = String(process.env.CORS_CREDENTIALS).toLowerCase() === 'true'
const corsOptions = rawOrigins.length
  ? { origin: rawOrigins, credentials: corsCredentials }
  : { origin: true, credentials: corsCredentials } // allow all in dev if not set

app.use(cors(corsOptions));
app.use(express.json())
// Basic health checks
app.get('/', (req, res) => res.status(200).send('OK'))
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }))
app.use('/api/users', userRoutes)
app.use('/api/whatsapp', whatsappRoutes)
app.use('/api/forms', formsRoutes)
app.use('/api/branches', branchRoutes)
app.use('/api/stocks', stocksRoutes)
app.use('/api/announcements', announcementRoutes)


const PORT = parseInt(process.env.PORT || '8082', 10)
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`)
})
