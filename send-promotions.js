const client = require('./src/client'); // Reutiliza a conexão do bot
const { findInactiveCustomers } = require('./src/database');

// Aguarda o cliente do WhatsApp estar pronto
client.on('ready', async () => {
    console.log('Cliente pronto para enviar promoções!');

    // Procura por clientes que não aparecem há mais de 90 dias
    const inactiveCustomers = await findInactiveCustomers(90);

    if (inactiveCustomers.length === 0) {
        console.log("Nenhum cliente inativo encontrado.");
        client.destroy(); // Fecha a conexão
        return;
    }

    const promoMessage = "Olá! Sentimos sua falta aqui na barbearia. Que tal um corte novo? Use o cupom VOLTA10 para 10% de desconto no seu próximo serviço!";

    for (const customer of inactiveCustomers) {
        try {
            console.log(`Enviando mensagem para ${customer.name} (${customer.phone})`);
            await client.sendMessage(customer.phone, promoMessage);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Espera 5s entre mensagens
        } catch (error) {
            console.error(`Falha ao enviar para ${customer.phone}:`, error);
        }
    }

    console.log("Campanha de promoções finalizada.");
    await client.destroy(); // Fecha a conexão
});

// Inicializa o cliente (ele vai gerar um QR code se não estiver logado)
client.initialize();