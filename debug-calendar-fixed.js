require('dotenv').config();

async function debugCalendar() {
    try {
        console.log('🔍 Debug do Calendar API...');
        
        // Verificar se a pasta src existe
        const fs = require('fs');
        const path = require('path');
        
        console.log('📁 Estrutura da pasta src:');
        if (fs.existsSync('./src')) {
            const srcFiles = fs.readdirSync('./src');
            srcFiles.forEach(file => {
                console.log('   📄', file);
            });
        } else {
            console.log('❌ Pasta src não encontrada');
            return;
        }

        // Tentar carregar os módulos com caminho correto
        let db, calendarApi;
        
        try {
            db = require('./src/database');
            console.log('✅ Módulo database carregado');
        } catch (error) {
            console.log('❌ Erro ao carregar database:', error.message);
            return;
        }
        
        try {
            calendarApi = require('./src/calendar');
            console.log('✅ Módulo calendar carregado');
        } catch (error) {
            console.log('❌ Erro ao carregar calendar:', error.message);
            return;
        }

        // Buscar cliente
        const clients = await db.getAllClients();
        if (clients.length === 0) {
            console.log('❌ Nenhum cliente encontrado');
            return;
        }

        const clientInfo = clients[0];
        console.log('\n📋 Informações do cliente:');
        console.log('- Nome:', clientInfo.name);
        console.log('- Calendar ID:', clientInfo.google_calendar_id);
        console.log('- Tem credenciais Google:', !!clientInfo.google_credentials);
        console.log('- Timezone:', clientInfo.timezone);
        console.log('- Work Schedule:', clientInfo.work_schedule ? '✅' : '❌');

        // Testar work_schedule manualmente
        if (clientInfo.work_schedule) {
            console.log('\n📅 Work Schedule detalhado:');
            const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            days.forEach(day => {
                const config = clientInfo.work_schedule[day];
                console.log(`   ${day}:`, config?.available ? `✅ ${config.start} - ${config.end}` : '❌ FECHADO');
            });
        }

        // Testar a função listAvailableDays
        console.log('\n🧪 Testando listAvailableDays...');
        
        if (!clientInfo.google_credentials || !clientInfo.google_calendar_id) {
            console.log('❌ Credenciais Google faltando');
            return;
        }

        const availableDays = await calendarApi.listAvailableDays(
            clientInfo.google_calendar_id,
            clientInfo.google_credentials,
            clientInfo.work_schedule || {},
            clientInfo.timezone || 'America/Sao_Paulo'
        );

        console.log('📅 Resultado de listAvailableDays:');
        console.log('- Total de dias:', availableDays.length);
        console.log('- Dias:', availableDays.map(d => d.formatted));

        if (availableDays.length === 0) {
            console.log('\n🔎 Investigando por que retornou vazio...');
            
            // Testar manualmente os próximos 7 dias
            console.log('\n📆 Próximos 7 dias (teste manual):');
            const startDate = new Date();
            const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            
            for (let i = 0; i < 7; i++) {
                const testDate = new Date(startDate);
                testDate.setDate(startDate.getDate() + i);
                
                const dayIndex = testDate.getDay();
                const dayKey = daysOfWeek[dayIndex];
                const dayConfig = clientInfo.work_schedule?.[dayKey];
                
                const dateStr = testDate.toLocaleDateString('pt-BR', {
                    weekday: 'long',
                    day: '2-digit',
                    month: '2-digit'
                });
                
                if (dayConfig?.available) {
                    console.log(`   ✅ ${dateStr}: ABERTO (${dayConfig.start} - ${dayConfig.end})`);
                } else {
                    console.log(`   ❌ ${dateStr}: FECHADO (${dayKey}: ${dayConfig ? 'available: false' : 'no config'})`);
                }
            }
        }

    } catch (error) {
        console.error('❌ Erro no debug:', error);
        console.error('Stack:', error.stack);
    }
}

debugCalendar();