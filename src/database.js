const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');

const db = new sqlite3.Database('./barber.db', (err) => {
    if (err) {
        console.error("Erro ao abrir o banco de dados", err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE,
            name TEXT,
            last_visit TEXT
        )`);
    }
});

/**
 * Salva ou atualiza os dados de um cliente.
 * @param {string} phone - O número de telefone do cliente.
 * @param {string} name - O nome do cliente.
 * @param {string} visitDate - A data da visita (em formato ISO).
 */
function saveCustomerVisit(phone, name, visitDate) {
    // Tenta encontrar um cliente com o mesmo telefone
    const query = `SELECT * FROM customers WHERE phone = ?`;

    db.get(query, [phone], (err, row) => {
        if (err) {
            console.error("Erro ao buscar cliente:", err.message);
            return;
        }

        if (row) {
            // Se o cliente já existe, atualiza o nome e a data da última visita
            const updateQuery = `UPDATE customers SET name = ?, last_visit = ? WHERE phone = ?`;
            db.run(updateQuery, [name, visitDate, phone]);
        } else {
            // Se não existe, insere um novo cliente
            const insertQuery = `INSERT INTO customers (phone, name, last_visit) VALUES (?, ?, ?)`;
            db.run(insertQuery, [phone, name, visitDate]);
        }
    });
}

/**
 * Encontra clientes que não visitam a barbearia há um tempo.
 * @param {number} days - O número de dias de inatividade.
 * @returns {Promise<Array>} Uma lista de clientes inativos.
 */
function findInactiveCustomers(days = 90) {
    return new Promise((resolve, reject) => {
        const dateLimit = new Date();
        dateLimit.setDate(dateLimit.getDate() - days);

        const query = `SELECT * FROM customers WHERE last_visit < ?`;

        db.all(query, [dateLimit.toISOString()], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}


module.exports = { saveCustomerVisit, findInactiveCustomers };