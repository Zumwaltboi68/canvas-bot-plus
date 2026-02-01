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
import fs from 'fs';

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
        this.log('ðŸš€ Initializing browser...');
        
        // Create screenshots directory in /tmp
        const screenshotsDir = '/tmp/canvas-bot-screenshots';
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
            this.log('ðŸ“ Created screenshots directory');
        }
        
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

        this.log('âœ… Browser initialized');
    }

    async login(username, password) {
        this.log('ðŸ” Logging into Canvas...');

        try {
            // Determine login URL and navigation strategy
            let loginUrl;
            let baseUrl;
            let navigateToLoginFirst = false;
            
            if (this.config.loginUrl) {
                // User provided custom login URL - go there first!
                loginUrl = this.config.loginUrl;
                const url = new URL(loginUrl);
                baseUrl = `${url.protocol}//${url.hostname}`;
                navigateToLoginFirst = true; // Custom login URL means different domain, go there first
                this.log(`ðŸ“ Using custom login URL: ${loginUrl}`);
                this.log(`ðŸ“ Quiz URL: ${this.config.canvasUrl}`);
                this.log(`ðŸ“ Strategy: Login at custom URL first, then navigate to quiz`);
            } else {
                // Auto-detect login URL from quiz URL
                const url = new URL(this.config.canvasUrl);
                baseUrl = `${url.protocol}//${url.hostname}`;
                loginUrl = baseUrl + '/login/canvas';
                this.log(`ðŸ“ Auto-detected base URL: ${baseUrl}`);
                this.log(`ðŸ“ Auto-detected login URL: ${loginUrl}`);
                this.log(`ðŸ“ Quiz URL: ${this.config.canvasUrl}`);
                this.log(`ðŸ“ Strategy: Navigate to quiz URL (may redirect to login)`);
            }

            // Navigate to the appropriate URL
            const initialUrl = navigateToLoginFirst ? loginUrl : this.config.canvasUrl;
            this.log(`ðŸ“ Navigating to: ${initialUrl}`);
            
            await this.page.goto(initialUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            await this.page.waitForTimeout(2000);

            // Log current URL after navigation
            const currentUrl = this.page.url();
            this.log(`ðŸ“ Current URL after navigation: ${currentUrl}`);

            // Check if already logged in
            if (currentUrl.includes('/courses/') && currentUrl.includes('/quizzes/')) {
                this.log('âœ… Already logged in (on quiz page)!');
                return true;
            }

            // Check if on dashboard (also means logged in)
            if (currentUrl.includes('/dashboard') || currentUrl.includes('?login_success=1')) {
                this.log('âœ… Already logged in (on dashboard)!');
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
            const screenshotPath = `/tmp/canvas-bot-screenshots/login-page-${Date.now()}.png`;
            await this.page.screenshot({ path: screenshotPath });
            this.log(`ðŸ“¸ Screenshot saved to ${screenshotPath}`);

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
            this.log(`ðŸ“‹ Found ${forms.length} forms on page`);
            forms.forEach((form, idx) => {
                this.log(`Form ${idx + 1}: id="${form.id}", name="${form.name}", action="${form.action}"`);
                form.inputs.forEach(input => {
                    this.log(`  Input: type="${input.type}", name="${input.name}", id="${input.id}", placeholder="${input.placeholder}"`);
                });
            });

            // Wait for login form to appear
            this.log('â³ Waiting for login form...');
            
            // Try GENERIC selectors first, then fallback to Canvas-specific ones
            const emailSelectors = [
                // MOST GENERIC FIRST - any visible text/email input
                'input[type="text"]',
                'input[type="email"]',
                'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])',
                
                // Then try placeholder-based
                'input[placeholder*="user" i]',
                'input[placeholder*="email" i]',
                'input[placeholder*="name" i]',
                
                // Then try name-based
                'input[name*="user" i]',
                'input[name*="username" i]',
                'input[name*="email" i]',
                
                // Then form-based
                'form input[type="text"]:first-of-type',
                'form input[type="email"]:first-of-type',
                '#login_form input[type="text"]',
                '#login_form input[type="email"]',
                
                // Canvas-specific LAST
                'input[name="pseudonym_session[unique_id]"]',
                '#pseudonym_session_unique_id'
            ];

            let emailInput = null;
            let usedSelector = null;
            
            for (const selector of emailSelectors) {
                try {
                    this.log(`ðŸ” Trying selector: ${selector}`);
                    emailInput = await this.page.waitForSelector(selector, { timeout: 3000 });
                    if (emailInput) {
                        // Get element details for logging
                        const elementInfo = await this.page.evaluate((sel) => {
                            const elem = document.querySelector(sel);
                            if (!elem) return null;
                            const style = window.getComputedStyle(elem);
                            return {
                                tagName: elem.tagName,
                                type: elem.type,
                                name: elem.name,
                                id: elem.id,
                                placeholder: elem.placeholder,
                                className: elem.className,
                                isVisible: style.display !== 'none' && 
                                          style.visibility !== 'hidden' && 
                                          style.opacity !== '0'
                            };
                        }, selector);
                        
                        if (elementInfo) {
                            this.log(`   Found: <${elementInfo.tagName} type="${elementInfo.type}" id="${elementInfo.id}" placeholder="${elementInfo.placeholder}">`);
                            this.log(`   Visible: ${elementInfo.isVisible}`);
                        }
                        
                        if (elementInfo && elementInfo.isVisible) {
                            usedSelector = selector;
                            this.log(`âœ… Using this field for username!`);
                            break;
                        } else {
                            this.log(`âš ï¸  Element found but not visible, trying next selector...`);
                            emailInput = null;
                        }
                    }
                } catch (e) {
                    this.log(`âŒ Selector "${selector}" not found on page`);
                    continue;
                }
            }

            if (!emailInput) {
                // Take another screenshot for debugging
                const errorScreenshotPath = `/tmp/canvas-bot-screenshots/login-error-${Date.now()}.png`;
                await this.page.screenshot({ path: errorScreenshotPath });
                
                // Get page HTML for debugging
                const html = await this.page.content();
                this.log(`ðŸ“„ Page HTML length: ${html.length} characters`);
                this.log(`ðŸ“¸ Error screenshot saved to ${errorScreenshotPath}`);
                
                throw new Error('Could not find email/username field. Check screenshots in outputs/screenshots/ for debugging.');
            }

            // Clear the field first
            await emailInput.click({ clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            
            // Enter credentials with realistic typing
            await emailInput.type(username, { delay: 100 });
            this.log(`âœ“ Entered username using selector: ${usedSelector}`);

            // Find password field - Canvas standard selectors
            const passwordSelectors = [
                // MOST GENERIC FIRST - any password input
                'input[type="password"]',
                
                // Then placeholder-based
                'input[placeholder*="password" i]',
                'input[placeholder*="pass" i]',
                
                // Then name-based
                'input[name*="password" i]',
                'input[name*="pass" i]',
                
                // Then form-based
                'form input[type="password"]',
                '#login_form input[type="password"]',
                
                // Canvas-specific LAST
                'input[name="pseudonym_session[password]"]',
                '#pseudonym_session_password'
            ];

            let passwordInput = null;
            let passwordSelector = null;
            
            for (const selector of passwordSelectors) {
                try {
                    this.log(`ðŸ” Trying password selector: ${selector}`);
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
                            this.log(`âœ… Found password field with selector: ${selector}`);
                            break;
                        } else {
                            passwordInput = null;
                        }
                    }
                } catch (e) {
                    this.log(`âŒ Password selector failed: ${selector} - ${e.message}`);
                    continue;
                }
            }

            if (!passwordInput) {
                throw new Error('Could not find password field');
            }

            await passwordInput.click({ clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            await passwordInput.type(password, { delay: 100 });
            this.log(`âœ“ Entered password using selector: ${passwordSelector}`);

            // Submit form - Canvas standard submit button
            const submitSelectors = [
                // Generic selectors FIRST
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Go")',
                'button:has-text("Log In")',
                'button:has-text("Login")',
                'button:has-text("Sign In")',
                'button:has-text("Submit")',
                // Canvas-specific
                'button.Button.Button--login',
                'button[type="submit"].Button--login',
                '#login_form button[type="submit"]',
                'button.login_button',
                '.btn-primary[type="submit"]'
            ];

            let submitted = false;
            for (const selector of submitSelectors) {
                try {
                    this.log(`ðŸ” Trying submit button selector: ${selector}`);
                    const button = await this.page.$(selector);
                    if (button) {
                        const buttonInfo = await this.page.evaluate((sel) => {
                            const elem = document.querySelector(sel);
                            if (!elem) return null;
                            const style = window.getComputedStyle(elem);
                            return {
                                text: elem.textContent?.trim() || elem.value,
                                type: elem.type,
                                tagName: elem.tagName,
                                isVisible: style.display !== 'none' && 
                                          style.visibility !== 'hidden' && 
                                          style.opacity !== '0'
                            };
                        }, selector);
                        
                        if (buttonInfo) {
                            this.log(`   Found: <${buttonInfo.tagName}> with text "${buttonInfo.text}" (visible: ${buttonInfo.isVisible})`);
                        }
                        
                        if (buttonInfo && buttonInfo.isVisible) {
                            this.log(`âœ… Clicking button: "${buttonInfo.text}"`);
                            await button.click();
                            submitted = true;
                            break;
                        }
                    }
                } catch (e) {
                    this.log(`âŒ Submit selector "${selector}" not found`);
                    continue;
                }
            }

            if (!submitted) {
                this.log('âš ï¸  No submit button found, pressing Enter as fallback');
                await passwordInput.press('Enter');
            }

            this.log('â³ Waiting for login to complete...');
            
            try {
                await this.page.waitForNavigation({ 
                    waitUntil: 'networkidle2',
                    timeout: 30000 
                });
            } catch (e) {
                this.log('âš ï¸  Navigation timeout, checking if login succeeded anyway');
            }

            // Verify login success
            await this.page.waitForTimeout(2000);
            const finalUrl = this.page.url();
            this.log(`ðŸ“ Final URL after login: ${finalUrl}`);
            
            // Take screenshot after login attempt
            const afterLoginPath = `/tmp/canvas-bot-screenshots/after-login-${Date.now()}.png`;
            await this.page.screenshot({ path: afterLoginPath });
            this.log(`ðŸ“¸ After-login screenshot: ${afterLoginPath}`);
            
            // Check if we're on a password page (multi-step login)
            if (finalUrl.includes('password') || finalUrl.includes('login')) {
                this.log('ðŸ” Detected multi-step login, looking for password field...');
                
                const passwordSelectors = [
                    // MOST GENERIC FIRST
                    'input[type="password"]',
                    'input[placeholder*="password" i]',
                    'input[name*="password" i]',
                    'form input[type="password"]'
                ];
                
                let passwordInput = null;
                for (const selector of passwordSelectors) {
                    try {
                        passwordInput = await this.page.waitForSelector(selector, { timeout: 3000 });
                        if (passwordInput) {
                            this.log(`âœ… Found password field: ${selector}`);
                            
                            // Clear and enter password
                            await passwordInput.click({ clickCount: 3 });
                            await this.page.keyboard.press('Backspace');
                            await passwordInput.type(password, { delay: 100 });
                            this.log('âœ“ Entered password');
                            
                            // Find and click submit button
                            const submitSelectors = [
                                'button[type="submit"]',
                                'input[type="submit"]',
                                'button:has-text("Go")',
                                'button:has-text("Login")',
                                'button:has-text("Sign In")',
                                'button:has-text("Submit")'
                            ];
                            
                            let submitted = false;
                            for (const selector of submitSelectors) {
                                try {
                                    const button = await this.page.$(selector);
                                    if (button) {
                                        await button.click();
                                        submitted = true;
                                        this.log('âœ“ Clicked submit button on password page');
                                        break;
                                    }
                                } catch (e) {
                                    continue;
                                }
                            }
                            
                            if (!submitted) {
                                await passwordInput.press('Enter');
                                this.log('âœ“ Pressed Enter on password field');
                            }
                            
                            // Wait for navigation after password
                            await this.page.waitForNavigation({ 
                                waitUntil: 'networkidle2',
                                timeout: 30000 
                            }).catch(() => {
                                this.log('âš ï¸ Navigation timeout after password, checking if login succeeded');
                            });
                            
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            
            // Final check
            await this.page.waitForTimeout(2000);
            const veryFinalUrl = this.page.url();
            this.log(`ðŸ“ Very final URL: ${veryFinalUrl}`);
            
            if (veryFinalUrl.includes('login') && !veryFinalUrl.includes('login_success')) {
                const finalErrorPath = `/tmp/canvas-bot-screenshots/login-final-error-${Date.now()}.png`;
                await this.page.screenshot({ path: finalErrorPath });
                this.log(`ðŸ“¸ Final error screenshot: ${finalErrorPath}`);
                throw new Error('Login failed - still on login page');
            }
            
            this.log('âœ… Successfully logged in!');
            
            // If we used a custom login URL, now navigate to the quiz URL
            if (navigateToLoginFirst && this.config.canvasUrl !== veryFinalUrl) {
                this.log(`ðŸŽ¯ Now navigating to quiz URL: ${this.config.canvasUrl}`);
                try {
                    await this.page.goto(this.config.canvasUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });
                    await this.page.waitForTimeout(2000);
                    const quizUrl = this.page.url();
                    this.log(`ðŸ“ Arrived at quiz page: ${quizUrl}`);
                } catch (e) {
                    this.log(`âš ï¸ Could not navigate to quiz URL: ${e.message}`, 'warning');
                    throw new Error(`Failed to navigate to quiz after login: ${e.message}`);
                }
            }
            
            return true;

        } catch (error) {
            this.log(`âŒ Login failed: ${error.message}`, 'error');
            // Take error screenshot
            try {
                const errorPath = `/tmp/canvas-bot-screenshots/login-exception-${Date.now()}.png`;
                await this.page.screenshot({ path: errorPath });
                this.log(`ðŸ“¸ Exception screenshot: ${errorPath}`);
            } catch (e) {}
            throw error;
        }
    }

    async navigateToQuiz() {
        this.log('ðŸ“ Navigating to quiz...');

        try {
            const currentUrl = this.page.url();
            
            // Check if we're already on the quiz page
            if (currentUrl.includes('/quizzes/')) {
                this.log('âœ… Already on quiz page!');
            } else {
                this.log(`ðŸ“ Current URL: ${currentUrl}`);
                this.log(`ðŸ“ Going to: ${this.config.canvasUrl}`);
                
                await this.page.goto(this.config.canvasUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
            }

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
                this.log('âœ… Quiz started successfully');
            } else {
                this.log('âš ï¸  Could not find quiz start button, assuming already in quiz');
            }

        } catch (error) {
            this.log(`âŒ Navigation error: ${error.message}`, 'error');
            throw error;
        }
    }

    async extractQuestions() {
        this.log('ðŸ“Š Extracting questions from quiz...');

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
            this.log(`âœ… Extracted ${questions.length} questions`);
            
            questions.forEach((q, i) => {
                this.log(`Q${i + 1}: ${q.type} - ${q.text.substring(0, 60)}...`);
            });

            return questions;

        } catch (error) {
            this.log(`âŒ Error extracting questions: ${error.message}`, 'error');
            throw error;
        }
    }

    async analyzeQuestionWithAI(question) {
        this.log(`ðŸ¤– Analyzing question with AI: ${question.text.substring(0, 50)}...`);

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
            this.log(`âœ… AI Answer: ${answer}`);

            return answer;

        } catch (error) {
            this.log(`âŒ AI Error: ${error.message}`, 'error');
            throw error;
        }
    }

    async answerQuestion(question, aiAnswer) {
        this.log(`ðŸ“ Answering question: ${question.text.substring(0, 50)}...`);

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

                    this.log(`âœ… Selected option ${answerLetter}: ${option.text}`);
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

                        this.log(`âœ… Selected option ${letter}: ${option.text}`);
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

                this.log(`âœ… Entered answer: ${aiAnswer.substring(0, 50)}...`);
            }

            this.answers.push({
                questionId: question.id,
                question: question.text,
                answer: aiAnswer,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.log(`âŒ Error answering question: ${error.message}`, 'error');
            throw error;
        }
    }

    async submitQuiz() {
        this.log('ðŸ“¤ Submitting quiz...');

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
                        this.log('âœ… Clicked submit button');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!submitted && this.config.autoSubmit) {
                this.log('âš ï¸  Could not find submit button');
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
                    this.log('âœ… Confirmed submission');
                }
            } catch (e) {
                // No confirmation needed
            }

        } catch (error) {
            this.log(`âš ï¸  Submit error: ${error.message}`, 'warning');
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

            this.log(`ðŸ“Š Processing ${questions.length} questions...`);

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

            this.log('ðŸŽ‰ Quiz completed successfully!');
            
            // Copy screenshots to outputs directory
            try {
                const screenshotsDir = '/tmp/canvas-bot-screenshots';
                const outputDir = '/mnt/user-data/outputs/screenshots';
                
                if (fs.existsSync(screenshotsDir)) {
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
                    
                    const files = fs.readdirSync(screenshotsDir);
                    for (const file of files) {
                        const src = path.join(screenshotsDir, file);
                        const dest = path.join(outputDir, file);
                        fs.copyFileSync(src, dest);
                    }
                    this.log(`ðŸ“¸ Copied ${files.length} screenshots to outputs directory`);
                }
            } catch (e) {
                this.log(`âš ï¸ Could not copy screenshots: ${e.message}`, 'warning');
            }
            
            return {
                success: true,
                questionsAnswered: this.answers.length,
                answers: this.answers
            };

        } catch (error) {
            this.log(`âŒ Fatal error: ${error.message}`, 'error');
            
            // Copy screenshots even on error
            try {
                const screenshotsDir = '/tmp/canvas-bot-screenshots';
                const outputDir = '/mnt/user-data/outputs/screenshots';
                
                if (fs.existsSync(screenshotsDir)) {
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
                    
                    const files = fs.readdirSync(screenshotsDir);
                    for (const file of files) {
                        const src = path.join(screenshotsDir, file);
                        const dest = path.join(outputDir, file);
                        fs.copyFileSync(src, dest);
                    }
                    this.log(`ðŸ“¸ Copied ${files.length} screenshots to outputs directory`);
                }
            } catch (e) {
                this.log(`âš ï¸ Could not copy screenshots: ${e.message}`, 'warning');
            }
            
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
                this.log('ðŸ”’ Browser closed');
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
    console.log(`ðŸš€ Canvas Quiz Bot Server running on http://localhost:${PORT}`);
    console.log(`ðŸ“¡ WebSocket server ready`);
});

// WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    console.log('ðŸ”Œ Client connected');
    
    ws.send(JSON.stringify({
        type: 'info',
        message: 'Connected to Canvas Quiz Bot server'
    }));

    ws.on('close', () => {
        console.log('ðŸ”Œ Client disconnected');
    });
});

export default app;
