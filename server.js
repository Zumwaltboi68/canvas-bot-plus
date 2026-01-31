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
            await this.page.goto(this.config.canvasUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            await this.page.waitForTimeout(2000);

            // Check if already logged in
            const currentUrl = this.page.url();
            if (currentUrl.includes('/courses/') && currentUrl.includes('/quizzes/')) {
                this.log('✅ Already logged in!');
                return true;
            }

            // Find login fields
            this.log('Looking for login form...');
            
            // Try multiple selectors for Canvas login
            const emailSelectors = [
                'input[type="email"]',
                'input[name="pseudonym_session[unique_id]"]',
                '#pseudonym_session_unique_id',
                'input[placeholder*="Email" i]',
                'input[placeholder*="Username" i]'
            ];

            let emailInput = null;
            for (const selector of emailSelectors) {
                try {
                    emailInput = await this.page.waitForSelector(selector, { timeout: 5000 });
                    if (emailInput) {
                        this.log(`Found email field with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!emailInput) {
                throw new Error('Could not find email/username field');
            }

            // Enter credentials
            await emailInput.type(username, { delay: 100 });
            this.log('✓ Entered username');

            const passwordSelectors = [
                'input[type="password"]',
                'input[name="pseudonym_session[password]"]',
                '#pseudonym_session_password'
            ];

            let passwordInput = null;
            for (const selector of passwordSelectors) {
                try {
                    passwordInput = await this.page.$(selector);
                    if (passwordInput) break;
                } catch (e) {
                    continue;
                }
            }

            if (!passwordInput) {
                throw new Error('Could not find password field');
            }

            await passwordInput.type(password, { delay: 100 });
            this.log('✓ Entered password');

            // Submit form
            const submitSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Log In")',
                '.Button--login'
            ];

            let submitted = false;
            for (const selector of submitSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button) {
                        await button.click();
                        submitted = true;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!submitted) {
                // Try pressing Enter as fallback
                await passwordInput.press('Enter');
            }

            this.log('⏳ Waiting for login to complete...');
            
            await this.page.waitForNavigation({ 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });

            // Verify login success
            await this.page.waitForTimeout(2000);
            const finalUrl = this.page.url();
            
            if (finalUrl.includes('login') || finalUrl.includes('signin')) {
                throw new Error('Login failed - still on login page');
            }

            this.log('✅ Successfully logged in!');
            return true;

        } catch (error) {
            this.log(`❌ Login failed: ${error.message}`, 'error');
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

            if (!quizStarted) {
                this.log('⚠️  Could not find quiz start button, assuming already on quiz page');
            }

            await this.page.waitForTimeout(3000);
            this.log('✅ On quiz page');

        } catch (error) {
            this.log(`❌ Navigation error: ${error.message}`, 'error');
            throw error;
        }
    }

    async extractQuestions() {
        this.log('🔍 Extracting questions from page...');

        try {
            const questions = await this.page.evaluate(() => {
                const questionElements = document.querySelectorAll('.question, .display_question, [class*="question"]');
                const extracted = [];

                questionElements.forEach((el, index) => {
                    // Get question text
                    const questionTextEl = el.querySelector('.question_text, .question_prompt, [class*="question_text"]');
                    const questionText = questionTextEl ? questionTextEl.innerText.trim() : '';

                    if (!questionText) return;

                    // Determine question type
                    let type = 'unknown';
                    let options = [];

                    // Multiple choice
                    if (el.querySelector('.answer_input input[type="radio"]')) {
                        type = 'multiple_choice';
                        const answerOptions = el.querySelectorAll('.answer');
                        answerOptions.forEach(opt => {
                            const label = opt.querySelector('.answer_label, label');
                            if (label) {
                                options.push({
                                    text: label.innerText.trim(),
                                    id: opt.querySelector('input')?.id || '',
                                    value: opt.querySelector('input')?.value || ''
                                });
                            }
                        });
                    }
                    // Multiple answers (checkboxes)
                    else if (el.querySelector('.answer_input input[type="checkbox"]')) {
                        type = 'multiple_answers';
                        const answerOptions = el.querySelectorAll('.answer');
                        answerOptions.forEach(opt => {
                            const label = opt.querySelector('.answer_label, label');
                            if (label) {
                                options.push({
                                    text: label.innerText.trim(),
                                    id: opt.querySelector('input')?.id || '',
                                    value: opt.querySelector('input')?.value || ''
                                });
                            }
                        });
                    }
                    // True/False
                    else if (questionText.toLowerCase().includes('true or false') || 
                             el.querySelector('input[value="true"]') ||
                             el.querySelectorAll('.answer').length === 2) {
                        type = 'true_false';
                        const answerOptions = el.querySelectorAll('.answer');
                        answerOptions.forEach(opt => {
                            const label = opt.querySelector('.answer_label, label');
                            if (label) {
                                options.push({
                                    text: label.innerText.trim(),
                                    id: opt.querySelector('input')?.id || '',
                                    value: opt.querySelector('input')?.value || ''
                                });
                            }
                        });
                    }
                    // Short answer / Essay
                    else if (el.querySelector('textarea, input[type="text"]')) {
                        type = el.querySelector('textarea') ? 'essay' : 'short_answer';
                    }

                    extracted.push({
                        id: index + 1,
                        text: questionText,
                        type: type,
                        options: options,
                        element: el.className
                    });
                });

                return extracted;
            });

            this.questions = questions.filter(q => q.text && q.text.length > 0);
            this.log(`✅ Found ${this.questions.length} questions`);
            
            return this.questions;

        } catch (error) {
            this.log(`❌ Error extracting questions: ${error.message}`, 'error');
            throw error;
        }
    }

    async analyzeQuestionWithAI(question) {
        this.log(`🤖 Analyzing question ${question.id} with AI...`);

        try {
            let prompt = `Question: ${question.text}\n\n`;

            if (question.type === 'multiple_choice' && question.options.length > 0) {
                prompt += 'Options:\n';
                question.options.forEach((opt, idx) => {
                    prompt += `${String.fromCharCode(65 + idx)}. ${opt.text}\n`;
                });
                prompt += '\n**Return ONLY the letter (A, B, C, D, etc.) of the correct answer.**';
            } else if (question.type === 'multiple_answers' && question.options.length > 0) {
                prompt += 'Options (select all that apply):\n';
                question.options.forEach((opt, idx) => {
                    prompt += `${String.fromCharCode(65 + idx)}. ${opt.text}\n`;
                });
                prompt += '\n**Return ONLY the letters (e.g., "A, C, D") of ALL correct answers.**';
            } else if (question.type === 'true_false') {
                prompt += '\n**Return ONLY "True" or "False".**';
            } else {
                prompt += '\n**Provide a concise, accurate answer.**';
            }

            const completion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert quiz assistant. Analyze questions carefully and provide accurate answers. Follow the format instructions exactly.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                model: 'mixtral-8x7b-32768',
                temperature: 0.2,
                max_tokens: 500
            });

            const answer = completion.choices[0].message.content.trim();
            this.log(`✅ AI Answer: ${answer}`);

            return answer;

        } catch (error) {
            this.log(`❌ AI analysis error: ${error.message}`, 'error');
            throw error;
        }
    }

    async answerQuestion(question, aiAnswer) {
        this.log(`✏️ Answering question ${question.id}...`);

        try {
            await this.page.waitForTimeout(
                this.config.delayMin * 1000 + 
                Math.random() * (this.config.delayMax - this.config.delayMin) * 1000
            );

            if (question.type === 'multiple_choice' || question.type === 'true_false') {
                // Parse the letter from AI answer
                const letterMatch = aiAnswer.match(/[A-Z]/);
                if (!letterMatch) {
                    throw new Error('Could not parse answer letter');
                }
                
                const answerIndex = letterMatch[0].charCodeAt(0) - 65;
                if (answerIndex < 0 || answerIndex >= question.options.length) {
                    throw new Error('Invalid answer index');
                }

                const option = question.options[answerIndex];
                
                // Click the radio button
                await this.page.evaluate((inputId) => {
                    const input = document.getElementById(inputId) || 
                                 document.querySelector(`input[value="${inputId}"]`);
                    if (input) {
                        input.click();
                        input.checked = true;
                    }
                }, option.id || option.value);

                this.log(`✅ Selected option ${letterMatch[0]}: ${option.text}`);

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

