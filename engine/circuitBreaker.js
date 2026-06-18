// engine/circuitBreaker.js
const config = require('../config/monitorConfig');

class CircuitBreaker {
    constructor() {
        this.state = 'closed'; // closed, open, half-open
        this.failures = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;
    }
    
    isOpen() {
        if (this.state === 'closed') return false;
        
        if (this.state === 'open') {
            const now = Date.now();
            if (now >= this.nextAttemptTime) {
                console.log('🔄 Circuit breaker transitioning to half-open');
                this.state = 'half-open';
                return false;
            }
            return true;
        }
        
        return false;
    }
    
    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        
        if (this.failures >= config.circuitBreaker.failureThreshold && this.state !== 'open') {
            console.log(`🔴 Circuit breaker OPEN after ${this.failures} failures`);
            this.state = 'open';
            this.nextAttemptTime = Date.now() + config.circuitBreaker.timeoutMs;
        }
    }
    
    recordSuccess() {
        if (this.state === 'half-open') {
            console.log('🟢 Circuit breaker closed (recovered)');
            this.state = 'closed';
            this.failures = 0;
        } else if (this.state === 'closed') {
            this.failures = Math.max(0, this.failures - 1);
        }
    }
    
    reset() {
        this.state = 'closed';
        this.failures = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;
    }
}

module.exports = CircuitBreaker;
