// dashboard.js
let currentToken = localStorage.getItem('clientToken');

// Verificar token
if (!currentToken) {
    window.location.href = '/client-login.html';
}

// Elementos DOM
const totalLivesEl = document.getElementById('totalLives');
const livesListEl = document.getElementById('livesList');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const resultBox = document.getElementById('resultBox');
const apiLinkEl = document.getElementById('apiLink');

let lastGeneratedLink = null;

// Carregar dados iniciais
async function loadDashboard() {
    await loadLives();
}

// Carregar lives
async function loadLives() {
    try {
        const response = await fetch('/client/lives', {
            headers: { 'Authorization': 'Bearer ' + currentToken }
        });
        
        if (!response.ok) throw new Error('Erro ao carregar lives');
        
        const data = await response.json();
        const lives = data.lives || [];
        
        totalLivesEl.textContent = lives.length;
        
        if (lives.length === 0) {
            livesListEl.innerHTML = '<p style="color: #666; text-align: center;">📭 Nenhuma live ativa. Adicione uma acima.</p>';
            return;
        }
        
        livesListEl.innerHTML = '';
        
        for (const live of lives) {
            const liveDiv = document.createElement('div');
            liveDiv.className = 'live-item';
            liveDiv.setAttribute('data-live-id', live.id);
            
            const statusClass = live.current_m3u8 ? 'status-online' : 'status-offline';
            const statusText = live.current_m3u8 ? '● AO VIVO' : '○ OFFLINE';
            
            liveDiv.innerHTML = `
                <div style="flex: 1;">
                    <div><strong>${live.title || 'Sem título'}</strong></div>
                    <div class="live-url">${live.youtube_url || live.url}</div>
                    <div class="live-status ${statusClass}">${statusText}</div>
                </div>
                <div class="live-actions">
                    <button class="btn-secondary" onclick="generateLink(${live.id})">🔗 Gerar Link</button>
                    <button class="btn-danger" onclick="removeLive(${live.id})">🗑️ Remover</button>
                </div>
            `;
            livesListEl.appendChild(liveDiv);
        }
        
    } catch (err) {
        console.error(err);
        errorEl.textContent = err.message;
        setTimeout(() => { errorEl.textContent = ''; }, 3000);
    }
}

// 🔥 GERAR LINK SEGURO (NOVO FORMATO /live/:token.m3u8)
async function generateLink(liveId) {
    try {
        console.log('Gerando link para live:', liveId);
        console.log('Token:', currentToken);
        
        const response = await fetch(`/client/generate-link/${liveId}`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentToken }
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao gerar link');
        }
        
        const data = await response.json();
        console.log('Link gerado:', data.secure_link);
        
        // Armazenar link gerado
        lastGeneratedLink = data.secure_link;
        
        // Mostrar no resultBox
        apiLinkEl.innerHTML = `<a href="${data.secure_link}" target="_blank">${data.secure_link}</a>`;
        resultBox.style.display = 'block';
        
        // Rolagem suave para o resultado
        resultBox.scrollIntoView({ behavior: 'smooth' });
        
        // Esconder após 30 segundos (opcional)
        setTimeout(() => {
            if (resultBox.style.display === 'block') {
                resultBox.style.display = 'none';
            }
        }, 30000);
        
    } catch (err) {
        console.error('Erro:', err);
        alert('Erro: ' + err.message);
    }
}

// Adicionar live
async function addLive() {
    const url = document.getElementById('liveUrl').value.trim();
    
    if (!url) {
        alert('Digite a URL do YouTube');
        return;
    }
    
    loadingEl.style.display = 'block';
    errorEl.textContent = '';
    resultBox.style.display = 'none';
    
    try {
        const response = await fetch('/monitor/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + currentToken
            },
            body: JSON.stringify({ url: url })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Erro ao adicionar live');
        }
        
        // Limpar campo
        document.getElementById('liveUrl').value = '';
        
        // Recarregar lista
        await loadLives();
        
        // Se retornou live_id, gerar link automaticamente
        if (data.live_id) {
            await generateLink(data.live_id);
        }
        
    } catch (err) {
        errorEl.textContent = err.message;
        setTimeout(() => { errorEl.textContent = ''; }, 3000);
    } finally {
        loadingEl.style.display = 'none';
    }
}

// Remover live
async function removeLive(liveId) {
    if (!confirm('Tem certeza que deseja remover esta live?')) return;
    
    try {
        const response = await fetch(`/client/lives/${liveId}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + currentToken }
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao remover live');
        }
        
        await loadLives();
        
    } catch (err) {
        alert('Erro: ' + err.message);
    }
}

// Copiar link
function copyLink() {
    if (lastGeneratedLink) {
        navigator.clipboard.writeText(lastGeneratedLink);
        alert('Link copiado!');
    }
}

// Logout
function logout() {
    localStorage.removeItem('clientToken');
    window.location.href = '/client-login.html';
}

// Inicializar
loadDashboard();

// Atualizar a cada 30 segundos
setInterval(loadLives, 30000);