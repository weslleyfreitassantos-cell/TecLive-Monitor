// ========================================
// YOUTUBE LIVE MONITOR - DASHBOARD JS
// ========================================

function getThumbnailUrl(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=)([^&]+)/);
    return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : '/images/placeholder.png';
}

async function loadStats() {
    try {
        const response = await fetch('/monitor/lives');
        const data = await response.json();
        document.getElementById('totalLives').innerText = data.total || 0;
        
        const livesList = document.getElementById('livesList');
        if (data.lives && data.lives.length > 0) {
            let html = '';
            for (let i = 0; i < data.lives.length; i++) {
                const live = data.lives[i];
                const thumbnail = getThumbnailUrl(live.url);
                const title = live.title || live.url.substring(0, 50);
                const fullLink = `http://${window.location.hostname}:3002/neonews/neonews.m3u8?url=${encodeURIComponent(live.url)}`;
                
                html += `
                    <div class="live-item">
                        <div class="live-thumb">
                            <img src="${thumbnail}" alt="Thumbnail" onerror="this.src='/images/placeholder.png'">
                            <span class="live-badge">AO VIVO</span>
                        </div>
                        <div class="live-info">
                            <div class="live-status">AO VIVO</div>
                            <div class="live-title">${escapeHtml(title)}</div>
                        </div>
                        <div class="live-link">
                            <div class="live-link-code">${fullLink.substring(0, 35)}...</div>
                            <button class="btn-link" onclick="copySpecificLink('${fullLink}')">📋 Copiar Link</button>
                            <button class="btn-danger" style="margin-top: 5px; padding: 4px 8px; font-size: 11px;" onclick="deleteLive('${escapeHtml(live.url)}')">🗑️ Excluir</button>
                        </div>
                    </div>
                `;
            }
            livesList.innerHTML = html;
        } else {
            livesList.innerHTML = '<p style="color: #666; text-align: center;">📭 Nenhuma live ativa. Adicione uma acima.</p>';
        }
    } catch (error) {
        console.error('Erro:', error);
    }
}

async function addLive() {
    const url = document.getElementById('liveUrl').value.trim();
    if (!url) {
        showError('Digite uma URL do YouTube');
        return;
    }

    showLoading(true);
    hideError();
    hideResult();

    try {
        const response = await fetch('/monitor/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        });
        const data = await response.json();
        
        if (data.success) {
            const apiLink = `http://${window.location.hostname}:3002/neonews/neonews.m3u8?url=${encodeURIComponent(url)}`;
            document.getElementById('apiLink').innerHTML = apiLink;
            showResult();
            document.getElementById('liveUrl').value = '';
            await loadStats();
            
            setTimeout(() => {
                hideResult();
            }, 5000);
        } else {
            showError(data.error || 'Erro ao adicionar live');
            setTimeout(() => {
                hideError();
            }, 3000);
        }
    } catch (error) {
        showError('Erro ao conectar com o servidor');
        setTimeout(() => {
            hideError();
        }, 3000);
    } finally {
        showLoading(false);
    }
}

// Excluir uma live individualmente
async function deleteLive(url) {
    if (!confirm('⚠️ Tem certeza que deseja parar o monitoramento desta live?')) return;
    
    showLoading(true);
    
    try {
        const response = await fetch('/monitor/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        });
        
        const data = await response.json();
        if (data.success) {
            alert('✅ Live removida com sucesso!');
            await loadStats();
        } else {
            alert('❌ Erro ao remover live: ' + (data.error || 'Tente novamente'));
        }
    } catch (error) {
        alert('❌ Erro ao conectar com o servidor');
    } finally {
        showLoading(false);
    }
}

// Excluir todas as lives
async function deleteAllLives() {
    if (!confirm('⚠️ ATENÇÃO! Isso irá parar o monitoramento de TODAS as lives. Continuar?')) return;
    
    showLoading(true);
    
    try {
        const response = await fetch('/monitor/lives');
        const data = await response.json();
        
        if (!data.lives || data.lives.length === 0) {
            alert('📭 Nenhuma live ativa para remover.');
            showLoading(false);
            return;
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const live of data.lives) {
            try {
                const stopResponse = await fetch('/monitor/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: live.url })
                });
                const stopData = await stopResponse.json();
                if (stopData.success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (e) {
                errorCount++;
            }
        }
        
        alert(`✅ ${successCount} lives removidas com sucesso!\n❌ ${errorCount} erros.`);
        await loadStats();
        
    } catch (error) {
        alert('❌ Erro ao buscar lista de lives');
    } finally {
        showLoading(false);
    }
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    if (show) {
        loading.classList.add('show');
    } else {
        loading.classList.remove('show');
    }
}

function showError(message) {
    const errorDiv = document.getElementById('error');
    errorDiv.innerHTML = `❌ ${message}`;
    errorDiv.classList.add('show');
}

function hideError() {
    const errorDiv = document.getElementById('error');
    errorDiv.classList.remove('show');
    errorDiv.innerHTML = '';
}

function showResult() {
    const resultBox = document.getElementById('resultBox');
    resultBox.classList.add('show');
}

function hideResult() {
    const resultBox = document.getElementById('resultBox');
    resultBox.classList.remove('show');
}

function copyLink() {
    const link = document.getElementById('apiLink').innerText;
    if (link) {
        navigator.clipboard.writeText(link);
        alert('✅ Link copiado!');
    }
}

function copySpecificLink(link) {
    navigator.clipboard.writeText(link);
    alert('✅ Link copiado!');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Inicialização
loadStats();
setInterval(loadStats, 15000);