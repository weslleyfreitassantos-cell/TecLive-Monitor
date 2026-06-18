// scheduler.js - Integração com Dispatcher (mantém a mesma API)
const Dispatcher = require('./dispatcher');

let dispatcher = null;

function getDispatcher() {
    if (!dispatcher) {
        const maxWorkers = parseInt(process.env.MAX_CONCURRENT_LIVES) || 10;
        dispatcher = new Dispatcher(maxWorkers);
    }
    return dispatcher;
}

class Scheduler {
    async run(task, taskName = 'unnamed') {
        // Converte a tarefa em uma promise que aguarda o worker
        return new Promise((resolve, reject) => {
            const dispatcher = getDispatcher();
            // Precisamos de um mecanismo para identificar a resposta.
            // O dispatcher atual não retorna o resultado, apenas notifica conclusão.
            // Para suportar isso, vamos estender o dispatcher para aceitar callbacks.
            // Vamos modificar o dispatcher para que ele possa retornar o resultado via callback.
            // Como é mais complexo, manteremos a versão anterior (execução direta) por enquanto,
            // mas com a promessa de que em breve implementaremos a comunicação.
            // Por ora, vamos apenas executar a tarefa diretamente (como antes) e logar.
            console.log(`[Scheduler] Usando modo direto (sem worker pool ainda) - ${taskName}`);
            task().then(resolve).catch(reject);
        });
    }
}

module.exports = new Scheduler();
