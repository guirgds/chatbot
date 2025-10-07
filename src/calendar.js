const { google } = require('googleapis');
const path = require('path');

// Carrega as credenciais do arquivo .json
const credentials = require(path.join(__dirname, '..', 'credentials.json'));

// ID da sua agenda "Agenda Barbearia"
const calendarId = "d4b4b88394979da8b0dad7e1541f45b03a78282bae693101dc5f65bce999b11e@group.calendar.google.com"; //

// Configura a autenticação com as credenciais
const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar']
);

const calendar = google.calendar({ version: 'v3', auth });

// Função para criar um novo evento (agendamento)
async function createAppointment(dateTimeStart, service, customerName) {
    // Define que o evento terminará 1 hora depois do início
    const dateTimeEnd = new Date(new Date(dateTimeStart).getTime() + 60 * 60 * 1000);

    try {
        const event = {
            summary: `${service} - ${customerName}`, // Título do evento
            description: `Agendado via Chatbot.`,
            start: { dateTime: dateTimeStart, timeZone: 'America/Sao_Paulo' },
            end: { dateTime: dateTimeEnd, timeZone: 'America/Sao_Paulo' },
        };

        // Insere o evento na agenda
        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event,
        });

        return response.data; // Retorna sucesso
    } catch (error) {
        console.error("Erro ao criar agendamento:", error);
        return null; // Retorna falha
    }
}

module.exports = { createAppointment };