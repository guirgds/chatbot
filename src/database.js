const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');
const logger = require('./logger'); // Assume que o logger está configurado

const dbPath = path.join(__dirname, '..', 'barber_saas.db'); // Nome do arquivo do BD multi-tenant

// Variável para guardar a Promise da instância do BD (Singleton Pattern)
let dbPromise = null;

/**
 * Inicializa o banco de dados e cria as tabelas se não existirem.
 * Retorna a instância do BD como uma Promise.
 */
async function initializeDatabase() {
    try {
        const db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        logger.info('Conectado ao banco de dados SQLite.', { path: dbPath });

        // Habilitar chaves estrangeiras (importante para integridade dos dados)
        await db.run('PRAGMA foreign_keys = ON;');

        // Criar tabelas sequencialmente para garantir dependências
        await db.exec(`
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_name TEXT NOT NULL,
                whatsapp_phone_id TEXT UNIQUE NOT NULL, -- ID do número fornecido pela Meta (phone_number_id)
                whatsapp_token TEXT NOT NULL,           -- Token de acesso da Meta para este cliente (long-lived)
                google_calendar_id TEXT,                -- ID do Google Calendar específico deste cliente
                google_credentials_json TEXT,           -- Conteúdo do JSON de credenciais do Google (armazenado como texto)
                config_json TEXT,                       -- Configs (serviços, durações, respostas keyword, etc. em JSON)
                timezone TEXT DEFAULT 'America/Sao_Paulo',
                work_schedule TEXT DEFAULT '{}',
                slot_interval INTEGER DEFAULT 30,
                max_daily_slots INTEGER DEFAULT 20,
                promo_template_name TEXT,               -- Nome do template de promoção aprovado na Meta
                promo_template_language TEXT,           -- Idioma do template (ex: pt_BR)
                promo_template_vars_json TEXT,          -- Variáveis da promoção em JSON (ex: {"coupon": "OFERTA10"})
                promo_enabled BOOLEAN DEFAULT 0,        -- Flag para ativar/desativar promoções (0=false, 1=true)
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        logger.info('Tabela "clients" verificada/criada.');

        // Tabela para clientes finais (renomeada do seu código anterior para 'customers')
        await db.exec(`
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,            -- Chave estrangeira para a tabela clients
                phone TEXT NOT NULL,                   -- Número do cliente final (formato E.164, ex: 555199998888)
                name TEXT,
                last_visit TEXT,                       -- Data da última visita/agendamento em formato ISO (YYYY-MM-DDTHH:mm:ss.sssZ)
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(client_id, phone),              -- Garante que um telefone é único por negócio
                FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
            );
        `);
        logger.info('Tabela "customers" verificada/criada.');

        await db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,            -- Chave estrangeira para a tabela clients
                customer_phone TEXT NOT NULL,          -- Telefone do cliente final (formato E.164)
                state_json TEXT,                       -- O objeto de estado da conversa em formato JSON
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(client_id, customer_phone),     -- Garante um estado por cliente/negócio
                FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
            );
        `);
        logger.info('Tabela "conversation_states" verificada/criada.');

        // REMOVIDA: A tabela 'visits' original foi incorporada/renomeada para 'customers'
        // Se precisar de um histórico detalhado de visitas, pode criar uma tabela 'appointments' separada.

        return db;
    } catch (err) {
        logger.error("Erro fatal ao inicializar o banco de dados", { error: err.message, path: dbPath });
        throw err; // Relança o erro para impedir a aplicação de iniciar incorretamente
    }
}

/**
 * Obtém a instância do BD (singleton pattern), inicializando-a se necessário.
 * @returns {Promise<import('sqlite').Database>} A instância do banco de dados.
 */
async function getDb() {
    if (!dbPromise) {
        dbPromise = initializeDatabase();
    }
    try {
        const db = await dbPromise;
        return db;
    } catch (error) {
        logger.error("Falha ao obter instância do BD após inicialização.", { error: error.message });
        dbPromise = null; // Resetar a promise para tentar inicializar de novo na próxima chamada
        throw error;
    }
}

function convertBusinessHoursToWorkSchedule(businessHours) {
    const workSchedule = {};
    
    const daysMap = {
        'monday': 'monday',
        'tuesday': 'tuesday', 
        'wednesday': 'wednesday',
        'thursday': 'thursday',
        'friday': 'friday',
        'saturday': 'saturday',
        'sunday': 'sunday'
    };

    Object.entries(daysMap).forEach(([enDay, ptDay]) => {
        const hours = businessHours[ptDay];
        if (hours && hours.open && hours.close) {
            // Converter "09:00" para 9, "18:00" para 18
            const start = parseInt(hours.open.split(':')[0]);
            const end = parseInt(hours.close.split(':')[0]);
            workSchedule[enDay] = {
                start: start,
                end: end,
                available: true
            };
        } else {
            workSchedule[enDay] = {
                start: 0,
                end: 0, 
                available: false
            };
        }
    });

    return workSchedule;
}

// --- Funções para Gerenciar Clientes (Negócios) ---

/**
 * Busca um cliente (negócio) pelo seu ID de telefone do WhatsApp (fornecido pela Meta).
 * @param {string} businessPhoneId - O ID do número de telefone (whatsapp_phone_id).
 * @returns {Promise<object|null>} O objeto do cliente (com JSONs parseados) ou null se não encontrado.
 */
async function getClientByPhoneId(businessPhoneId) {
    if (!businessPhoneId) return null;
    const db = await getDb();
    const query = `SELECT * FROM clients WHERE whatsapp_phone_id = ?`;
    try {
        const client = await db.get(query, [businessPhoneId]);
        if (!client) return null;

        // **[LOG ADICIONADO]** Loga as strings JSON brutas lidas do BD
        logger.debug('Raw config_json from DB:', { rawJson: client.config_json });
        logger.debug('Raw work_schedule from DB:', { rawWorkSchedule: client.work_schedule });

        // Parsear JSONs com segurança ao ler do BD
        try {
            client.google_credentials = client.google_credentials_json ? JSON.parse(client.google_credentials_json) : null;
        } catch (e) { 
            logger.error('Erro ao parsear google_credentials_json', { clientId: client.id, error: e.message, rawJson: client.google_credentials_json }); 
            client.google_credentials = null; 
        }
        
        try {
            client.config = client.config_json ? JSON.parse(client.config_json) : {}; // Default para objeto vazio
        } catch (e) {
            logger.error('Erro ao parsear config_json', { clientId: client.id, error: e.message, rawJson: client.config_json }); 
            client.config = {}; // Define como objeto vazio se o parse falhar
        }
        
        try {
            client.promo_template_vars = client.promo_template_vars_json ? JSON.parse(client.promo_template_vars_json) : {};
        } catch (e) { 
            logger.error('Erro ao parsear promo_template_vars_json', { clientId: client.id, error: e.message, rawJson: client.promo_template_vars_json }); 
            client.promo_template_vars = {}; 
        }

        // SEMPRE usar work_schedule, NUNCA usar business_hours como fallback
        try {
            client.work_schedule = client.work_schedule ? JSON.parse(client.work_schedule) : null;
        } catch (e) {
            logger.error('Erro ao parsear work_schedule', { clientId: client.id, error: e.message, rawJson: client.work_schedule });
            client.work_schedule = null;
        }

        //Se work_schedule não existir, criar um padrão SEM usar business_hours
        if (!client.work_schedule || Object.keys(client.work_schedule).length === 0) {
            logger.warn('Work schedule não encontrado, criando configuração padrão', { clientId: client.id });
            client.work_schedule = {
                "monday": {"start": 9, "end": 18, "available": true},
                "tuesday": {"start": 9, "end": 18, "available": true},
                "wednesday": {"start": 9, "end": 18, "available": true},
                "thursday": {"start": 9, "end": 18, "available": true},
                "friday": {"start": 9, "end": 18, "available": true},
                "saturday": {"start": 9, "end": 17, "available": true},
                "sunday": {"start": 0, "end": 0, "available": false}
            };
        }

        //Log para debug
        logger.debug('Work schedule final carregado:', { 
            workSchedule: client.work_schedule,
            clientId: client.id 
        });

        // Garantir que timezone tenha um valor padrão
        if (!client.timezone) {
            client.timezone = 'America/Sao_Paulo';
        }

        // Garantir que slot_interval e max_daily_slots tenham valores padrão
        if (!client.slot_interval) {
            client.slot_interval = 30;
        }
        if (!client.max_daily_slots) {
            client.max_daily_slots = 20;
        }

        return client;
    } catch (err) {
        logger.error("Erro ao buscar cliente por whatsapp_phone_id:", { error: err.message, businessPhoneId });
        throw err; // Propaga o erro
    }
}

/**
 * Busca o ID interno de um cliente (negócio) pelo seu ID de telefone do WhatsApp.
 * Reutiliza getClientByPhoneId.
 * @param {string} businessPhoneId - O ID do número de telefone (whatsapp_phone_id).
 * @returns {Promise<number|null>} O ID do cliente ou null se não encontrado.
 */
async function getClientIdByPhoneId(businessPhoneId) {
    const client = await getClientByPhoneId(businessPhoneId);
    return client ? client.id : null;
}

// --- Funções para Gerenciar Clientes Finais ---
/**
 * Salva ou atualiza os dados de um cliente final (associado a um negócio).
 * Usa lógica UPSERT (Update or Insert).
 * @param {number} clientId - O ID do negócio.
 * @param {string} phone - O número de telefone do cliente final (formato E.164).
 * @param {string} name - O nome do cliente final.
 * @param {string} visitDateISO - A data da visita em formato ISO string (YYYY-MM-DDTHH:mm:ss.sssZ).
 */
async function saveCustomerVisit(clientId, phone, name, visitDateISO) {
    const db = await getDb();
    const query = `
        INSERT INTO customers (client_id, phone, name, last_visit)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id, phone) DO UPDATE SET
            name = excluded.name,
            last_visit = excluded.last_visit;
    `;
    try {
        await db.run(query, [clientId, phone, name, visitDateISO]);
        // logger.info('Visita do cliente final salva/atualizada', { clientId, phone }); // Log pode ser verboso
    } catch (err) {
        logger.error("Erro ao salvar visita do cliente final (UPSERT):", { error: err.message, clientId, phone });
        // Considerar relançar o erro dependendo da criticidade
    }
}

/**
 * Encontra clientes finais inativos para um negócio específico.
 * @param {number} clientId - O ID do negócio.
 * @param {number} [days=90] - O número de dias desde a última visita.
 * @returns {Promise<Array<object>>} Uma lista de objetos customer { id, client_id, phone, name, last_visit, ... }.
 */
async function findInactiveCustomers(clientId, days = 90) {
    const db = await getDb();
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - days);
    const query = `SELECT * FROM customers WHERE client_id = ? AND last_visit < ? ORDER BY last_visit ASC`;

    try {
        const rows = await db.all(query, [clientId, dateLimit.toISOString()]);
        logger.info(`Encontrados ${rows.length} clientes inativos para clientId ${clientId}`);
        return rows;
    } catch (err) {
        logger.error("Erro ao buscar clientes inativos:", { error: err.message, clientId });
        throw err; // Propaga o erro
    }
}

// --- Funções para Gerenciar Estado da Conversa ---

/**
 * Busca o estado atual da conversa para um cliente final e um negócio.
 * @param {string} customerPhone - Telefone do cliente final (formato E.164).
 * @param {number} clientId - ID do negócio.
 * @returns {Promise<object|null>} O objeto de estado parseado ou null se não houver estado ou erro no parse.
 */
async function getConversationState(customerPhone, clientId) {
    const db = await getDb();
    const query = `SELECT state_json FROM conversation_states WHERE client_id = ? AND customer_phone = ?`;
    try {
        const row = await db.get(query, [clientId, customerPhone]);
        if (row && row.state_json) {
            try {
                return JSON.parse(row.state_json);
            } catch (parseError) {
                logger.error("Erro ao parsear state_json do BD:", { parseError: parseError.message, clientId, customerPhone, rawJson: row.state_json });
                // Deletar estado corrompido para evitar loop de erro
                await deleteConversationState(customerPhone, clientId);
                return null;
            }
        }
        return null;
    } catch (err) {
        logger.error("Erro ao buscar estado da conversa:", { error: err.message, clientId, customerPhone });
        throw err; // Propaga o erro
    }
}

/**
 * Salva ou atualiza o estado da conversa usando UPSERT.
 * @param {string} customerPhone - Telefone do cliente final (formato E.164).
 * @param {number} clientId - ID do negócio.
 * @param {object} state - O objeto de estado da conversa.
 */
async function saveConversationState(customerPhone, clientId, state) {
    const db = await getDb();
    let stateJson;
    try {
        stateJson = JSON.stringify(state);
    } catch (stringifyError) {
        logger.error("Erro ao converter estado da conversa para JSON:", { stringifyError: stringifyError.message, clientId, customerPhone /* state pode ser grande, omitir se necessário */ });
        throw stringifyError; // Não salvar estado inválido
    }
    const now = new Date().toISOString();
    const query = `
        INSERT INTO conversation_states (client_id, customer_phone, state_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id, customer_phone) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at;
    `;
    try {
        await db.run(query, [clientId, customerPhone, stateJson, now]);
        // logger.debug('Estado da conversa salvo', { clientId, customerPhone }); // Log debug pode ser verboso
    } catch (err) {
        logger.error("Erro ao salvar estado da conversa (UPSERT):", { error: err.message, clientId, customerPhone });
        throw err; // Propaga o erro
    }
}

/**
 * Deleta o estado da conversa (quando ela termina ou é resetada).
 * @param {string} customerPhone - Telefone do cliente final (formato E.164).
 * @param {number} clientId - ID do negócio.
 */
async function deleteConversationState(customerPhone, clientId) {
    const db = await getDb();
    const query = `DELETE FROM conversation_states WHERE client_id = ? AND customer_phone = ?`;
    try {
        await db.run(query, [clientId, customerPhone]);
        // logger.debug('Estado da conversa deletado', { clientId, customerPhone });
    } catch (err) {
        logger.error("Erro ao deletar estado da conversa:", { error: err.message, clientId, customerPhone });
        throw err; // Propaga o erro
    }
}

// Exportar as funções que serão usadas pelos outros módulos
module.exports = {
    getDb, 
    getClientByPhoneId,
    getClientIdByPhoneId,
    saveCustomerVisit,
    findInactiveCustomers,
    getConversationState,
    saveConversationState,
    deleteConversationState
};