const { listAvailableSlots } = require('./src/calendar');
const creds = require('./credentials.json'); // ou o JSON inline
(async () => {
  try {
    const result = await listAvailableSlots(
      new Date(),
      30,
      'barbearia-bot@group.calendar.google.com',
      creds,
      'America/Sao_Paulo',
      { start: 9, end: 18 },
      { minAdvanceMinutes: 60, allowSameDay: true }
    );
    console.log('✅ Slots encontrados:', result.map(r => r.toLocaleString('pt-BR')));
  } catch (e) {
    console.error('❌ Erro:', e.message);
  }
})();
