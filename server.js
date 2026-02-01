import express from 'express';
import puppeteer from 'puppeteer';
import { Groq } from 'groq-sdk';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const rateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 60,
});

// WebSocket server for real-time updates
const wss = new WebSocketServer({ noServer: true });

// Store active sessions
const activeSessions = new Map();

// Broadcast to all connected clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(JSON.stringify(data));
        }
    });
}

// Canvas Quiz Bot Class
class CanvasQuizBot {
    constructor(config) {
        this.config = config;
        this.browser = null;
        this.page = null;
        this.groq = new Groq({ apiKey: config.groqApiKey });
        this.questions = [];
        this.answers = [];
        this.sessionId = Date.now().toString();
    }

    log(message, type = 'info') {
        const logData = {
            type,
            message,
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId
        };
        console.log(`[${type.toUpperCase()}] ${message}`);
        broadcast(logData);
    }

    async initialize() {
        this.log('🚀 Initializing browser...');
        
        this.browser = await puppeteer.launch({
            headless: this.config.headless !== false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        });

        this.page = await this.browser.newPage();
        
        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        this.log('✅ Browser initialized');
    }

    async login(username, password) {
        this.log('🔐 Logging into Canvas...');

        try {
            // Determine login URL
            let loginUrl;
            let baseUrl;
            
            if (this.config.loginUrl) {
                // User provided custom login URL
                loginUrl = this.config.loginUrl;
                const url = new URL(loginUrl);
                baseUrl = `${url.protocol}//${url.hostname}`;
                this.log(`📍 Using custom login URL: ${loginUrl}`);
            } else {
                // Auto-detect login URL from quiz URL
                const url = new URL(this.config.canvasUrl);
                baseUrl = `${url.protocol}//${url.hostname}`;
                loginUrl = baseUrl + '/login/canvas';
                this.log(`📍 Auto-detected base URL: ${baseUrl}`);
                this.log(`📍 Auto-detected login URL: ${loginUrl}`);
            }
            
            this.log(`📍 Quiz URL: ${this.config.canvasUrl}`);

            await this.page.goto(this.config.canvasUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            await this.page.waitForTimeout(2000);

            // Log current URL after navigation
            const currentUrl = this.page.url();
            this.log(`📍 Current URL after navigation: ${currentUrl}`);

            // Check if already logged in
            if (currentUrl.includes('/courses/') && currentUrl.includes('/quizzes/')) {
                this.log('✅ Already logged in (on quiz page)!');
                return true;
            }

            // Check if on dashboard (also means logged in)
            if (currentUrl.includes('/dashboard') || currentUrl.includes('?login_success=1')) {
                this.log('✅ Already logged in (on dashboard)!');
                // Navigate to quiz URL if we're on dashboard
                if (this.config.canvasUrl !== currentUrl) {
                    await this.page.goto(this.config.canvasUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });
                }
                return true;
            }

            // DEBUG: Take a screenshot and log page structure
            await this.page.screenshot({ path: '/tmp/login-page.png' });
            this.log('📸 Screenshot saved to /tmp/login-page.png');

            // DEBUG: Log all forms on the page
            const forms = await this.page.evaluate(() => {
                return Array.from(document.querySelectorAll('form')).map(form => ({
                    id: form.id,
                    name: form.name,
                    action: form.action,
                    inputs: Array.from(form.querySelectorAll('input')).map(input => ({
                        type: input.type,
                        name: input.name,
                        id: input.id,
                        placeholder: input.placeholder,
                        className: input.className
                    }))
                }));
            });
            this.log(`📋 Found ${forms.length} forms on page`);
            forms.forEach((form, idx) => {
                this.log(`Form ${idx + 1}: id="${form.id}", name="${form.name}", action="${form.action}"`);
                form.inputs.forEach(input => {
                    this.log(`  Input: type="${input.type}", name="${input.name}", id="${input.id}", placeholder="${input.placeholder}"`);
                });
            });

            // Wait for login form to appear
            this.log('⏳ Waiting for login form...');
            
            // Canvas standard login form selectors based on official source code
            // The form typically has id="login_form" and inputs have specific names
            const emailSelectors = [
                // Standard Canvas login - most common
                'input[name="pseudonym_session[unique_id]"]',
                '#pseudonym_session_unique_id',
                // Alternative selectors
                'input[type="email"]',
                'input[type="text"][name*="username" i]',
                'input[type="text"][name*="email" i]',
                'input[placeholder*="Email" i]',
                'input[placeholder*="Username" i]',
                '#login_form input[type="text"]',
                '#login_form input[type="email"]',
                // Generic fallbacks
                'form input[type="email"]:first-of-type',
                'form input[type="text"]:first-of-type'
            ];

            let emailInput = null;
            let usedSelector = null;
            
            for (const selector of emailSelectors) {
                try {
                    this.log(`🔍 Trying selector: ${selector}`);
                    emailInput = await this.page.waitForSelector(selector, { timeout: 3000 });
                    if (emailInput) {
                        // Verify the element is visible
                        const isVisible = await this.page.evaluate((sel) => {
                            const elem = document.querySelector(sel);
                            if (!elem) return false;
                            const style = window.getComputedStyle(elem);
                            return style.display !== 'none' && 
                                   style.visibility !== 'hidden' && 
                                   style.opacity !== '0';
                        }, selector);
                        
                        if (isVisible) {
                            usedSelector = selector;
                            this.log(`✅ Found email field with selector: ${selector}`);
                            break;
                        } else {
                            this.log(`⚠️  Element found but not visible: ${selector}`);
                            emailInput = null;
                        }
                    }
                } catch (e) {
                    this.log(`❌ Selector failed: ${selector} - ${e.message}`);
                    continue;
                }
            }

            if (!emailInput) {
                // Take another screenshot for debugging
                await this.page.screenshot({ path: '/tmp/login-error.png' });
                
                // Get page HTML for debugging
                const html = await this.page.content();
                this.log(`📄 Page HTML saved for debugging`);
                
                throw new Error('Could not find email/username field. Check screenshots in /tmp/ for debugging.');
            }

            // Clear the field first
            await emailInput.click({ clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            
            // Enter credentials with realistic typing
            await emailInput.type(username, { delay: 100 });
            this.log(`✓ Entered username using selector: ${usedSelector}`);

            // Find password field - Canvas standard selectors
            const passwordSelectors = [
                // Standard Canvas login - most common
                'input[name="pseudonym_session[password]"]',
                '#pseudonym_session_password',
                // Alternative selectors
                'input[type="password"]',
                '#login_form input[type="password"]',
                // Generic fallback
                'form input[type="password"]'
            ];

            let passwordInput = null;
            let passwordSelector = null;
            
            for (const selector of passwordSelectors) {
                try {
                    this.log(`🔍 Trying password selector: ${selector}`);
                    passwordInput = await this.page.waitForSelector(selector, { timeout: 3000 });
                    if (passwordInput) {
                        const isVisible = await this.page.evaluate((sel) => {
                            const elem = document.querySelector(sel);
                            if (!elem) return false;
                            const style = window.getComputedStyle(elem);
                            return style.display !== 'none' && 
                                   style.visibility !== 'hidden' && 
                                   style.opacity !== '0';
                        }, selector);
                        
                        if (isVisible) {
                            passwordSelector = selector;
                            this.log(`✅ Found password field with selector: ${selector}`);
                            break;
                        } else {
                            passwordInput = null;
                        }
                    }
                } catch (e) {
                    this.log(`❌ Password selector failed: ${selector} - ${e.message}`);
                    continue;
                }
            }

            if (!passwordInput) {
                throw new Error('Could not find password field');
            }

            await passwordInput.click({ clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            await passwordInput.type(password, { delay: 100 });
            this.log(`✓ Entered password using selector: ${passwordSelector}`);

            // Submit form - Canvas standard submit button
            const submitSelectors = [
                // Canvas standard login button
                'button.Button.Button--login',
                'button[type="submit"].Button--login',
                '#login_form button[type="submit"]',
                'button.login_button',
                // Generic selectors
                'button[type="submit"]',
                'input[type="submit"]',
                '.btn-primary[type="submit"]',
                'button:has-text("Log In")',
                'button:has-text("Login")'
            ];

            let submitted = false;
            for (const selector of submitSelectors) {
                try {
                    this.log(`🔍 Trying submit button selector: ${selector}`);
                    const button = await this.page.$(selector);
                    if (button) {
                        const isVisible = await this.page.evaluate((sel) => {
                            const elem = document.querySelector(sel);
                            if (!elem) return false;
                            const style = window.getComputedStyle(elem);
                            return style.display !== 'none' && 
                                   style.visibility !== 'hidden' && 
                                   style.opacity !== '0';
                        }, selector);
                        
                        if (isVisible) {
                            this.log(`✅ Found submit button: ${selector}`);
                            await button.click();
                            submitted = true;
                            break;
                        }
                    }
                } catch (e) {
                    this.log(`❌ Submit selector failed: ${selector}`);
                    continue;
                }
            }

            if (!submitted) {
                this.log('⚠️  No submit button found, pressing Enter as fallback');
                await passwordInput.press('Enter');
            }

            this.log('⏳ Waiting for login to complete...');
            
            try {
                await this.page.waitForNavigation({ 
                    waitUntil: 'networkidle2',
                    timeout: 30000 
                });
            } catch (e) {
                this.log('⚠️  Navigation timeout, checking if login succeeded anyway');
            }

            // Verify login success
            await this.page.waitForTimeout(2000);
            const finalUrl = this.page.url();
            this.log(`📍 Final URL after login: ${finalUrl}`);
            
            // Take screenshot after login attempt
            await this.page.screenshot({ path: '/tmp/after-login.png' });
            
            if (finalUrl.includes('login') && !finalUrl.includes('login_success')) {
                throw new Error('Login failed - still on login page');
            }

            this.log('✅ Successfully logged in!');
            return true;

        } catch (error) {
            this.log(`❌ Login failed: ${error.message}`, 'error');
            // Take error screenshot
            try {
                await this.page.screenshot({ path: '/tmp/login-final-error.png' });
            } catch (e) {}
            throw error;
        }
    }

    async navigateToQuiz() {
        this.log('📝 Navigating to quiz...');

        try {
            await this.page.goto(this.config.canvasUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            await this.page.waitForTimeout(2000);

            // Look for "Take the Quiz" or "Resume Quiz" button
            const startButtonSelectors = [
                'a.btn:has-text("Take the Quiz")',
                'button:has-text("Take the Quiz")',
                'a:has-text("Resume Quiz")',
                'button:has-text("Resume")',
                '.take_quiz_button',
                '#take_quiz_link'
            ];

            let quizStarted = false;
            for (const selector of startButtonSelectors) {
                try {
                    const button = await this.page.waitForSelector(selector, { timeout: 5000 });
                    if (button) {
                        this.log(`Found start button: ${selector}`);
                        await button.click();
                        quizStarted = true;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (quizStarted) {
                await this.page.waitForNavigation({
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
                this.log('✅ Quiz started successfully');
            } else {
                this.log('⚠️  Could not find quiz start button, assuming already in quiz');
            }

        } catch (error) {
            this.log(`❌ Navigation error: ${error.message}`, 'error');
            throw error;
        }
    }

    async extractQuestions() {
        this.log('📊 Extracting questions from quiz...');

        try {
            await this.page.waitForTimeout(2000);

            const questions = await this.page.evaluate(() => {
                const questionElements = document.querySelectorAll('.question');
                const extractedQuestions = [];

                questionElements.forEach((element, index) => {
                    const questionText = element.querySelector('.question_text')?.innerText ||
                                       element.querySelector('.text')?.innerText || '';

                    const type = element.className.includes('multiple_choice') ? 'multiple_choice' :
                               element.className.includes('true_false') ? 'true_false' :
                               element.className.includes('multiple_answers') ? 'multiple_answers' :
                               element.className.includes('short_answer') ? 'short_answer' :
                               element.className.includes('essay') ? 'essay' : 'unknown';

                    const options = [];
                    element.querySelectorAll('.answer').forEach(answer => {
                        const label = answer.querySelector('label');
                        const input = answer.querySelector('input');
                        if (label && input) {
                            options.push({
                                text: label.innerText.trim(),
                                id: input.id,
                                value: input.value
                            });
                        }
                    });

                    extractedQuestions.push({
                        id: element.id || `question_${index}`,
                        text: questionText.trim(),
                        type: type,
                        options: options,
                        element: element.id
                    });
                });

                return extractedQuestions;
            });

            this.questions = questions;
            this.log(`✅ Extracted ${questions.length} questions`);
            
            questions.forEach((q, i) => {
                this.log(`Q${i + 1}: ${q.type} - ${q.text.substring(0, 60)}...`);
            });

            return questions;

        } catch (error) {
            this.log(`❌ Error extracting questions: ${error.message}`, 'error');
            throw error;
        }
    }

    async analyzeQuestionWithAI(question) {
        this.log(`🤖 Analyzing question with AI: ${question.text.substring(0, 50)}...`);

        try {
            let prompt = `You are taking a quiz. Answer the following question:\n\n${question.text}\n\n`;

            if (question.type === 'multiple_choice' || question.type === 'true_false' || question.type === 'multiple_answers') {
                prompt += 'Options:\n';
                question.options.forEach((opt, idx) => {
                    prompt += `${String.fromCharCode(65 + idx)}. ${opt.text}\n`;
                });
                
                if (question.type === 'multiple_choice' || question.type === 'true_false') {
                    prompt += '\nProvide ONLY the letter of the correct answer (A, B, C, D, etc.). No explanation.';
                } else {
                    prompt += '\nProvide ONLY the letters of ALL correct answers separated by commas (e.g., A,C,D). No explanation.';
                }
            } else {
                prompt += '\nProvide a concise answer to this question.';
            }

            const completion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant taking a quiz. Provide concise, accurate answers."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.3,
                max_tokens: 500
            });

            const answer = completion.choices[0]?.message?.content?.trim() || '';
            this.log(`✅ AI Answer: ${answer}`);

            return answer;

        } catch (error) {
            this.log(`❌ AI Error: ${error.message}`, 'error');
            throw error;
        }
    }

    async answerQuestion(question, aiAnswer) {
        this.log(`📝 Answering question: ${question.text.substring(0, 50)}...`);

        try {
            // Scroll to question
            await this.page.evaluate((elementId) => {
                const element = document.getElementById(elementId);
                if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, question.element);

            await this.page.waitForTimeout(1000);

            // Answer based on question type
            if (question.type === 'multiple_choice' || question.type === 'true_false') {
                // Extract letter from AI response
                const letterMatch = aiAnswer.match(/[A-Z]/);
                if (!letterMatch) {
                    throw new Error(`Could not extract answer letter from: ${aiAnswer}`);
                }

                const answerLetter = letterMatch[0];
                const answerIndex = answerLetter.charCodeAt(0) - 65; // A=0, B=1, etc.

                if (answerIndex >= 0 && answerIndex < question.options.length) {
                    const option = question.options[answerIndex];
                    
                    await this.page.evaluate((inputId) => {
                        const input = document.getElementById(inputId) || 
                                     document.querySelector(`input[value="${inputId}"]`);
                        if (input) {
                            input.click();
                            input.checked = true;
                        }
                    }, option.id || option.value);

                    this.log(`✅ Selected option ${answerLetter}: ${option.text}`);
                } else {
                    throw new Error(`Invalid answer index: ${answerIndex}`);
                }

            } else if (question.type === 'multiple_answers') {
                // Parse multiple letters
                const letters = aiAnswer.match(/[A-Z]/g) || [];
                
                for (const letter of letters) {
                    const answerIndex = letter.charCodeAt(0) - 65;
                    if (answerIndex >= 0 && answerIndex < question.options.length) {
                        const option = question.options[answerIndex];
                        
                        await this.page.evaluate((inputId) => {
                            const input = document.getElementById(inputId) || 
                                         document.querySelector(`input[value="${inputId}"]`);
                            if (input) {
                                input.click();
                                input.checked = true;
                            }
                        }, option.id || option.value);

                        this.log(`✅ Selected option ${letter}: ${option.text}`);
                    }
                }

            } else if (question.type === 'short_answer' || question.type === 'essay') {
                // Find text input or textarea
                await this.page.evaluate((answer) => {
                    const inputs = document.querySelectorAll('input[type="text"], textarea');
                    if (inputs.length > 0) {
                        const input = inputs[inputs.length - 1];
                        input.value = answer;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, aiAnswer);

                this.log(`✅ Entered answer: ${aiAnswer.substring(0, 50)}...`);
            }

            this.answers.push({
                questionId: question.id,
                question: question.text,
                answer: aiAnswer,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.log(`❌ Error answering question: ${error.message}`, 'error');
            throw error;
        }
    }

    async submitQuiz() {
        this.log('📤 Submitting quiz...');

        try {
            // Look for submit button
            const submitSelectors = [
                'button.submit_quiz_button',
                'button:has-text("Submit Quiz")',
                'input[value="Submit Quiz"]',
                '.quiz_submit'
            ];

            let submitted = false;
            for (const selector of submitSelectors) {
                try {
                    const button = await this.page.waitForSelector(selector, { timeout: 5000 });
                    if (button) {
                        await button.click();
                        submitted = true;
                        this.log('✅ Clicked submit button');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!submitted && this.config.autoSubmit) {
                this.log('⚠️  Could not find submit button');
            }

            await this.page.waitForTimeout(3000);

            // Handle confirmation dialog if present
            try {
                const confirmButton = await this.page.waitForSelector(
                    'button:has-text("Submit"), button:has-text("OK"), button:has-text("Yes")',
                    { timeout: 3000 }
                );
                if (confirmButton) {
                    await confirmButton.click();
                    this.log('✅ Confirmed submission');
                }
            } catch (e) {
                // No confirmation needed
            }

        } catch (error) {
            this.log(`⚠️  Submit error: ${error.message}`, 'warning');
        }
    }

    async run() {
        try {
            await this.initialize();

            if (this.config.username && this.config.password) {
                await this.login(this.config.username, this.config.password);
            }

            await this.navigateToQuiz();
            const questions = await this.extractQuestions();

            this.log(`📊 Processing ${questions.length} questions...`);

            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                
                broadcast({
                    type: 'progress',
                    current: i + 1,
                    total: questions.length,
                    question: question
                });

                const aiAnswer = await this.analyzeQuestionWithAI(question);
                await this.answerQuestion(question, aiAnswer);
            }

            if (this.config.autoSubmit) {
                await this.submitQuiz();
            }

            this.log('🎉 Quiz completed successfully!');
            
            return {
                success: true,
                questionsAnswered: this.answers.length,
                answers: this.answers
            };

        } catch (error) {
            this.log(`❌ Fatal error: ${error.message}`, 'error');
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
                this.log('🔒 Browser closed');
            }
        }
    }
}

// API Routes
app.post('/api/start-quiz', async (req, res) => {
    try {
        await rateLimiter.consume(req.ip);

        const config = {
            groqApiKey: req.body.groqApiKey,
            canvasUrl: req.body.canvasUrl,
            loginUrl: req.body.loginUrl, // Optional custom login URL
            username: req.body.username,
            password: req.body.password,
            delayMin: req.body.delayMin || 2,
            delayMax: req.body.delayMax || 5,
            headless: req.body.headless !== false,
            autoSubmit: req.body.autoSubmit !== false
        };

        if (!config.groqApiKey) {
            return res.status(400).json({ error: 'Groq API key is required' });
        }

        if (!config.canvasUrl) {
            return res.status(400).json({ error: 'Canvas URL is required' });
        }

        const bot = new CanvasQuizBot(config);
        activeSessions.set(bot.sessionId, bot);

        // Run bot in background
        bot.run()
            .then(result => {
                broadcast({
                    type: 'complete',
                    result
                });
                activeSessions.delete(bot.sessionId);
            })
            .catch(error => {
                broadcast({
                    type: 'error',
                    message: error.message
                });
                activeSessions.delete(bot.sessionId);
            });

        res.json({
            success: true,
            sessionId: bot.sessionId,
            message: 'Quiz bot started'
        });

    } catch (error) {
        if (error.message.includes('rate limit')) {
            res.status(429).json({ error: 'Too many requests. Please wait.' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        activeSessions: activeSessions.size,
        uptime: process.uptime()
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// HTTP server
const server = app.listen(PORT, () => {
    console.log(`🚀 Canvas Quiz Bot Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket server ready`);
});

// WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    
    ws.send(JSON.stringify({
        type: 'info',
        message: 'Connected to Canvas Quiz Bot server'
    }));

    ws.on('close', () => {
        console.log('🔌 Client disconnected');
    });
});

export default app;
