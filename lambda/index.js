// npm i aws-sdk chrome-aws-lambda puppeteer-core request request-promise

/*

CreateConnect Event:

{
  "properties": {
    "Domain": "9030bff7"
  }
}

ResetEmail Event:

{
  "email": "example7@awsaccounts.ian.mn"
}

*/

const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const AWS = require('aws-sdk');
const fs = require('fs');
const url = require('url');
var rp = require('request-promise');

var s3 = new AWS.S3();
var rekognition = new AWS.Rekognition();

const CAPTCHA_KEY = process.env.CAPTCHA_KEY;
const MASTER_PWD = process.env.MASTER_PWD;
const CC_NUM = process.env.CC_NUM;
const CC_NAME = process.env.CC_NAME;
const CC_MONTH = process.env.CC_MONTH;
const CC_YEAR = process.env.CC_YEAR;
const ACCOUNTID = process.env.ACCOUNTID;

const solveCaptchaRekog = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var code = null;
    
    await new Promise(function (resolve, reject) {
        rekognition.detectText({
            Image: {
                Bytes: Buffer.from(imgbody)
            }
        }, function(err, data) {
            console.log(data);
            console.log(err);

            if (data) {
                data.TextDetections.forEach(textDetection => {
                    var text = textDetection.DetectedText.replace(/\ /g, "");
                    if (text.length == 6) {
                        code = text;
                    }
                });
            }
            
            resolve();
        });
    });

    console.log(code);

    if (!code) {
        let refreshbutton = await page.$('.refresh')
        refreshbutton.click();
        await page.waitFor(5000);
    }

    return code;
}

const solveCaptcha = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var captcharef = await rp({ uri: 'http://2captcha.com/in.php', method: 'POST', body: JSON.stringify({
        'key': CAPTCHA_KEY,
        'method': 'base64',
        'body': "data:image/jpeg;base64," + new Buffer(imgbody).toString('base64')
    })}).then(res => {
        console.log(res);
        return res.split("|").pop();
    });;

    var captcharesult = '';
    var i = 0;
    while (!captcharesult.startsWith("OK") && i < 20) {
        await new Promise(resolve => { setTimeout(resolve, 5000); });

        var captcharesult = await rp({ uri: 'http://2captcha.com/res.php?key=' + CAPTCHA_KEY + '&action=get&id=' + captcharef, method: 'GET' }).then(res => {
            console.log(res);
            return res;
        });

        i++;
    }

    return captcharesult.split("|").pop();
}

const uploadResult = async (url, data) => {
    await rp({ uri: url, method: 'PUT', body: JSON.stringify(data) });
}

const debugScreenshot = async (page) => {
    let filename = Date.now().toString() + ".png";

    await page.screenshot({ path: '/tmp/' + filename });

    await new Promise(function (resolve, reject) {
        fs.readFile('/tmp/' + filename, (err, data) => {
            if (err) console.error(err);

            var base64data = new Buffer(data, 'binary');

            var params = {
                Bucket: process.env.DEBUG_BUCKET,
                Key: filename,
                Body: base64data
            };

            s3.upload(params, (err, data) => {
                if (err) console.error(`Upload Error ${err}`);
                console.log('Upload Completed');
                resolve();
            });
        });
    });
};

async function login(page) {
    //var secretsmanager = new AWS.SecretsManager();
    var passwordstr = "";
    passwordstr = process.env.CONNECT_PASSWORD;

    /*
    await new Promise(function (resolve, reject) {
        secretsmanager.getSecretValue({
            SecretId: process.env.CONNECT_PASSWORD_SECRET
        }, function (err, data) {
            if (err) {
                console.log(err, err.stack);
                reject();
            }

            passwordstr = JSON.parse(data.SecretString).password;
            resolve();
        });
    });
    */

    await page.goto('https://' + process.env.ACCOUNTID + '.signin.aws.amazon.com/console');
    await debugScreenshot(page);

    let username = await page.$('#username');
    await username.press('Backspace');
    await username.type(process.env.CONNECT_USERNAME, { delay: 100 });

    let password = await page.$('#password');
    await password.press('Backspace');
    await password.type(passwordstr, { delay: 100 });

    let signin_button = await page.$('#signin_button');
    signin_button.click();

    await debugScreenshot(page);

    await page.waitFor(5000);
}

async function createinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/onboarding');
    await page.waitFor(5000);

    let directory = await page.$('input[ng-model="ad.directoryAlias"]');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });

    page.focus('button.awsui-button-variant-primary');
    let next1 = await page.$('button.awsui-button-variant-primary');
    next1.click();

    await page.waitForSelector('label.vertical-padding.option-label');
    await page.waitFor(200);
    let skipradio = await page.$$('label.vertical-padding.option-label');
    skipradio.pop().click();

    await page.waitFor(200);

    let next2 = await page.$('button[type="submit"].awsui-button-variant-primary');
    next2.click();

    await page.waitFor(200);

    let next3 = await page.$('button[type="submit"].awsui-button-variant-primary');
    next3.click();

    await page.waitFor(200);

    let next4 = await page.$('button[type="submit"].awsui-button-variant-primary');
    next4.click();

    await page.waitFor(200);

    let next5 = await page.$('button[type="submit"].awsui-button-variant-primary');
    next5.click();

    await page.waitFor(200);

    let finish = await page.$('button[type="submit"].awsui-button-variant-primary');
    finish.click();

    await page.waitForSelector('div.launch-page-login-link', {timeout: 180000});

    await debugScreenshot(page);

    await page.waitFor(3000);
}

async function open(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home');
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    let entry = await page.$('table > tbody > tr > td:nth-child(1) > div > a');
    await entry.click();

    await page.waitFor(5000);

    let loginbutton = await page.$('a[ng-show="org.organizationId"]');
    let loginlink = await page.evaluate((obj) => {
        return obj.getAttribute('href');
    }, loginbutton);

    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com' + loginlink);

    await page.waitFor(8000);

    await debugScreenshot(page);
}

async function deleteinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home');
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    let checkbox = await page.$$('awsui-checkbox > label > input');
    await checkbox[0].click();
    await page.waitFor(200);

    await debugScreenshot(page);
    console.log("Clicked checkbox");

    let removebutton = await page.$$('button[type="submit"]');
    console.log(removebutton.length);
    await removebutton[1].click();
    console.log("Clicked remove");
    await page.waitFor(200);

    let directory = await page.$('#awsui-textfield-1');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });
    await page.waitFor(200);

    let confirm = await page.$('awsui-button[click="confirmDeleteOrg()"] > button');
    await confirm.click();
    await page.waitFor(5000);

    await debugScreenshot(page);
}

async function claimnumber(page, properties) {
    let host = 'https://' + new url.URL(await page.url()).host;

    console.log(host + '/connect/numbers/claim');

    await page.goto(host + '/connect/numbers/claim');
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    let did = await page.$('li[heading="DID (Direct Inward Dialing)"] > a');
    await did.click();

    await page.waitFor(200);

    let ccinput = await page.$('div.active > span > div.country-code-real-input');
    await ccinput.click();

    await page.waitFor(200);

    let countryitem = await page.$('div.active > span.country-code-input.ng-scope > ul > li:nth-child(1)');
    await countryitem.click();

    await page.waitFor(5000);

    let phonenumberselection = await page.$('div.active > awsui-radio-group > div > span > div:nth-child(1) > awsui-radio-button > label.awsui-radio-button-wrapper-label > div');
    await phonenumberselection.click();
    let phonenumber = await page.$('div.active > awsui-radio-group > div > span > div:nth-child(1) > awsui-radio-button > label.awsui-radio-button-checked.awsui-radio-button-label > div > span > div');
    let phonenumbertext = await page.evaluate(el => el.textContent, phonenumber);

    await page.waitFor(200);

    await debugScreenshot(page);

    let disclaimerlink = await page.$('div.tab-pane.ng-scope.active > div.alert.alert-warning.ng-scope > a');
    if (disclaimerlink !== null) {
        disclaimerlink.click();
    }

    await page.waitFor(200);

    await debugScreenshot(page);

    let s2id = await page.$('#s2id_select-width > a');
    await s2id.click();
    await page.waitFor(2000);

    await debugScreenshot(page);

    let s2input = await page.$('#select2-drop > div > input');
    await s2input.press('Backspace');
    await s2input.type("myFlow", { delay: 100 });
    await page.waitFor(2000);
    await s2input.press('Enter');
    await page.waitFor(1000);

    await debugScreenshot(page);

    let savenumber = await page.$('awsui-button[text="Save"] > button');
    await savenumber.click();
    await page.waitFor(5000);

    await debugScreenshot(page);

    return {
        'PhoneNumber': phonenumbertext
    };
}

async function uploadprompts(page, properties) {
    let host = 'https://' + new url.URL(await page.url()).host;

    let ret = {};
    
    let prompt_filenames = [
        'a-10-second-silence.wav',
        '9.wav',
        '8.wav',
        '7.wav',
        '6.wav',
        '5.wav',
        '4.wav',
        '3.wav',
        '2.wav',
        '1.wav',
        '0.wav'
    ];
    
    for (var pid in prompt_filenames) {
        let filename = prompt_filenames[pid];

        do {
            await page.goto(host + "/connect/prompts/create");
            await page.waitFor(5000);
            console.log("Checking for correct load");
            console.log(host + "/connect/prompts/create");
        } while (await page.$('#uploadFileBox') === null);

        await debugScreenshot(page);

        const fileInput = await page.$('#uploadFileBox');
        await fileInput.uploadFile(process.env.LAMBDA_TASK_ROOT + '/prompts/' + filename);

        await page.waitFor(1000);

        let input1 = await page.$('#name');
        await input1.press('Backspace');
        await input1.type(filename, { delay: 100 });

        await debugScreenshot(page);

        let submitbtn = await page.$('#lily-save-resource-button');
        await submitbtn.click();

        await page.waitFor(8000);

        await debugScreenshot(page);
        
        let promptid = await page.$eval('#collapsePrompt0 > div > div:nth-child(2) > table > tbody > tr > td', el => el.textContent);
        console.log("PROMPT ID:");
        console.log(promptid);
        ret[filename] = promptid;
    };

    await debugScreenshot(page);

    return ret;
}

async function createflow(page, properties, prompts) {
    let host = 'https://' + new url.URL(await page.url()).host;
    
    do {
        await page.goto(host + "/connect/contact-flows/create?type=contactFlow");
        await page.waitFor(5000);
        console.log("Checking for correct load");
        console.log(host + "/connect/contact-flows/create?type=contactFlow");
    } while (await page.$('#angularContainer') === null);

    await debugScreenshot(page);

    let dropdown = await page.$('#can-edit-contact-flow > div > awsui-button > button');
    console.log(dropdown);
    await dropdown.click();

    await page.waitFor(200);

    await debugScreenshot(page);

    let importbutton = await page.$('li[ng-if="cfImportExport"]');
    console.log(importbutton);
    await importbutton.click();

    await page.waitFor(500);

    await page.setBypassCSP(true);

    await debugScreenshot(page);

    fs.writeFileSync("/tmp/flow.json", `{
    "modules": [
        {
            "id": "a238d7ff-9df4-481b-bcf5-e472c3a51abf",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "39ca9b44-c416-45eb-b2c0-591956bd2fe9"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt2",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 700,
                    "y": 16
                },
                "useDynamic": true
            }
        },
        {
            "id": "1f4d3616-77cc-4cef-8881-949c531e13ce",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "a238d7ff-9df4-481b-bcf5-e472c3a51abf"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt1",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 456,
                    "y": 19
                },
                "useDynamic": true
            }
        },
        {
            "id": "ad3b6726-dfed-40fe-b4c7-95a9751fc4a7",
            "type": "InvokeExternalResource",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "1f4d3616-77cc-4cef-8881-949c531e13ce"
                },
                {
                    "condition": "Error",
                    "transition": "f5205242-eeb0-4b71-bb47-f8c2adf848fa"
                }
            ],
            "parameters": [
                {
                    "name": "FunctionArn",
                    "value": "arn:aws:lambda:us-east-1:${ACCOUNTID}:function:AccountAutomator",
                    "namespace": null
                },
                {
                    "name": "TimeLimit",
                    "value": "10"
                }
            ],
            "metadata": {
                "position": {
                    "x": 191,
                    "y": 15
                },
                "dynamicMetadata": {},
                "useDynamic": false
            },
            "target": "Lambda"
        },
        {
            "id": "39ca9b44-c416-45eb-b2c0-591956bd2fe9",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "406812d0-65de-4f5a-ba33-89c450b94238"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt3",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 948,
                    "y": 18
                },
                "useDynamic": true
            }
        },
        {
            "id": "f5205242-eeb0-4b71-bb47-f8c2adf848fa",
            "type": "Disconnect",
            "branches": [],
            "parameters": [],
            "metadata": {
                "position": {
                    "x": 1442,
                    "y": 22
                }
            }
        },
        {
            "id": "406812d0-65de-4f5a-ba33-89c450b94238",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "2298a0bd-cb66-4476-b1cb-1680a079eca6"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt4",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 1198,
                    "y": 17
                },
                "useDynamic": true
            }
        },
        {
            "id": "2298a0bd-cb66-4476-b1cb-1680a079eca6",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "f5205242-eeb0-4b71-bb47-f8c2adf848fa"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "${prompts['a-10-second-silence.wav']}",
                    "namespace": null,
                    "resourceName": "a-10-second-silence.wav"
                }
            ],
            "metadata": {
                "position": {
                    "x": 1395,
                    "y": 268
                },
                "useDynamic": false,
                "promptName": "a-10-second-silence.wav"
            }
        },
        {
            "id": "e30d63b7-e7d5-42df-9dea-f93e0bed321d",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "ad3b6726-dfed-40fe-b4c7-95a9751fc4a7"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "${prompts['a-10-second-silence.wav']}",
                    "namespace": null,
                    "resourceName": "a-10-second-silence.wav"
                }
            ],
            "metadata": {
                "position": {
                    "x": 120,
                    "y": 242
                },
                "useDynamic": false,
                "promptName": "a-10-second-silence.wav"
            }
        }
    ],
    "version": "1",
    "type": "contactFlow",
    "start": "e30d63b7-e7d5-42df-9dea-f93e0bed321d",
    "metadata": {
        "entryPointPosition": {
            "x": 24,
            "y": 17
        },
        "snapToGrid": false,
        "name": "myFlow",
        "description": "An example flow",
        "type": "contactFlow",
        "status": "published",
        "hash": "f8c17f9cd5523dc9c62111e55d2c225e0ee90ad8d509d677429cf6f7f2497a2f"
    }
}`, {
        mode: 0o777
    });

    await page.waitFor(5000);

    page.click('#import-cf-file-button');
    let fileinput = await page.$('#import-cf-file');
    console.log(fileinput);
    await fileinput.uploadFile('/tmp/flow.json'); // broken!

    await page.waitFor(5000);

    let doimport = await page.$('awsui-button[text="Import"] > button');
    await doimport.click();

    await page.waitFor(5000);

    await debugScreenshot(page);

    await dropdown.click();
    await page.waitFor(200);

    let savebutton = await page.$('#cf-dropdown > li:nth-child(1) > a');
    await savebutton.click();
    await page.waitFor(200);

    let saveandpublishbutton = await page.$('awsui-button[text="Save & publish"] > button');
    await saveandpublishbutton.click();

    await page.waitFor(5000);

    await debugScreenshot(page);
}

async function handleEmailInbound(page, event) {
    for (const record of event['Records']) {
        console.log(record.s3);
        var email = '';
        
        await s3.getObject({
            Bucket: record.s3.bucket.name,
            Key: record.s3.object.key
        }).promise().then(async (data) => {
            let body = data.Body.toString().replace(/=3D/g, '=').replace(/=\r\n/g, '');
            email = body.substring(body.indexOf("To: ") + 4, body.indexOf("\n", body.indexOf("To: ")));
            console.log("EMAIL IS:");
            console.log(email);
            let start = body.indexOf("https://signin.aws.amazon.com/resetpassword");
            if (start !== -1) {
                let end = body.indexOf("<", start);
                let url = body.substring(start, end);
                console.log(url);
                
                await page.goto(url);
                await page.waitFor(5000);

                await debugScreenshot(page);

                let input = await page.$('#new_password');
                await input.press('Backspace');
                await input.type(MASTER_PWD, { delay: 100 });

                let input2 = await page.$('#confirm_password');
                await input2.press('Backspace');
                await input2.type(MASTER_PWD, { delay: 100 });

                let submit = await page.$('#reset_password_submit');
                await submit.click();
                await page.waitFor(5000);

                console.log("Completed resetpassword link verification");
            }
        });

        await page.goto('https://console.aws.amazon.com/console/home');
        await page.waitForSelector('#resolving_input', {timeout: 15000});
        await page.waitFor(500);

        console.log("Entering email " + email);
        let input = await page.$('#resolving_input');
        await input.press('Backspace');
        await input.type(email, { delay: 100 });

        let nextbutton = await page.$('#next_button');
        await nextbutton.click();

        await debugScreenshot(page);

        await page.waitFor(5000);

        try {
            await debugScreenshot(page);
            let recaptchaimgx = await page.$('#captcha_image');
            let recaptchaurlx = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimgx);

            console.log("CAPTCHA IMG URL:");
            console.log(recaptchaurlx);
            let result = await solveCaptcha(page, recaptchaurlx);

            console.log("CAPTCHA RESULT:");
            console.log(result);

            let input3 = await page.$('#captchaGuess');
            await input3.press('Backspace');
            await input3.type(result, { delay: 100 });

            await debugScreenshot(page);
            
            let submitc = await page.$('#submit_captcha');
            await submitc.click();
            await page.waitFor(5000);
        } catch (error) {
            console.log(error);
        }

        await debugScreenshot(page);
        
        let input4 = await page.$('#password');
        await input4.press('Backspace');
        await input4.type(MASTER_PWD, { delay: 100 });

        let submitd = await page.$('#signin_button');
        await submitd.click();
        await page.waitFor(8000);
        
        await debugScreenshot(page);

        await page.goto('https://portal.aws.amazon.com/billing/signup?client=organizations&enforcePI=True');
        await page.waitFor(8000);
        
        await debugScreenshot(page);
        console.log("Screenshotted at portal");
        console.log(page.mainFrame().url());
        if (page.mainFrame().url().split("#").pop() != "/identityverification") {

            let input5 = await page.$('#credit-card-number');
            await input5.press('Backspace');
            await input5.type(CC_NUM, { delay: 100 });

            await page.select('#expirationMonth', (parseInt(CC_MONTH)-1).toString());

            await page.waitFor(2000);
            await debugScreenshot(page);

            let currentyear = new Date().getFullYear();

            await page.select('select[name=\'expirationYear\']', (parseInt(CC_YEAR)-currentyear).toString());

            let input6 = await page.$('#accountHolderName');
            await input6.press('Backspace');
            await input6.type(CC_NAME, { delay: 100 });

            await page.waitFor(2000);
            await debugScreenshot(page);

            let ccsubmit = await page.$('.form-submit-click-box > button');
            await ccsubmit.click();

            await page.waitFor(8000);
        }
        await debugScreenshot(page);

        // #phoneNumber
        // #imageCaptcha
        // #guess
        
    }
    
    return true;
};

async function triggerReset(page, event) {
    await page.goto('https://console.aws.amazon.com/console/home');
    await page.waitForSelector('#resolving_input', {timeout: 15000});
    await page.waitFor(500);

    let input = await page.$('#resolving_input');
    await input.press('Backspace');
    await input.type(event.email, { delay: 100 });

    let nextbutton = await page.$('#next_button');
    await nextbutton.click();

    await debugScreenshot(page);

    await page.waitFor(5000);

    var captchanotdone = true;
    while (captchanotdone) {
        try {
            let submitc = await page.$('#submit_captcha');

            await debugScreenshot(page);
            let recaptchaimgx = await page.$('#captcha_image');
            let recaptchaurlx = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimgx);

            console.log("CAPTCHA IMG URL:");
            console.log(recaptchaurlx);
            let result = await solveCaptcha(page, recaptchaurlx);

            console.log("CAPTCHA RESULT:");
            console.log(result);

            let input3 = await page.$('#captchaGuess');
            await input3.press('Backspace');
            await input3.type(result, { delay: 100 });

            await debugScreenshot(page);
            await submitc.click();
            await page.waitFor(5000);

            await debugScreenshot(page);

            let forgotpwdlink = await page.$('#root_forgot_password_link');
            await forgotpwdlink.click();
            
            captchanotdone = false;
        } catch (error) {
            console.log(error);
        }
    }

    await page.waitFor(5000);
    await debugScreenshot(page);

    await page.waitForSelector('#password_recovery_captcha_image', {timeout: 15000});

    await debugScreenshot(page);

    let recaptchaimg = await page.$('#password_recovery_captcha_image');
    let recaptchaurl = await page.evaluate((obj) => {
        return obj.getAttribute('src');
    }, recaptchaimg);

    console.log(recaptchaurl);
    let captcharesult = await solveCaptcha(page, recaptchaurl);

    let input2 = await page.$('#password_recovery_captcha_guess');
    await input2.press('Backspace');
    await input2.type(captcharesult, { delay: 100 });

    await page.waitFor(3000);

    await debugScreenshot(page);

    let submit = await page.$('#password_recovery_ok_button');
    await submit.click();
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.waitFor(2000);
};

exports.handler = async (event, context) => {
    let result = null;
    let browser = null;

    if (event.email) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await triggerReset(page, event);
    } else if (event.Records) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await handleEmailInbound(page, event);
    } else if (event.fragment) {
        let macro_response = {
            'requestId': event['requestId'],
            'status': 'success'
        };
        let response = event.fragment;

        macro_response['fragment'] = response;
        for (var k in response.Resources) {
            if (response.Resources[k]['Type'].startsWith('AWS::Connect::')) {
                if (!response.Resources[k]['Properties']) {
                    response.Resources[k]['Properties'] = {};
                }
                response.Resources[k]['Type'] = 'Custom::' + response.Resources[k]['Type'].replace(/\:\:/g, '_');
                response.Resources[k]['Properties']['ServiceToken'] = context.invokedFunctionArn;
            }
        }

        return macro_response;
    } else if (event.properties) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();
        
        await login(page);
        await createinstance(page, event.properties);
        await open(page, event.properties);
        let prompts = await uploadprompts(page, event.properties);
        await createflow(page, event.properties, prompts);
        let number = await claimnumber(page, event.properties);
        console.log(number);
        //await deleteinstance(page, event.properties);
    } else {
        return context.succeed();
    }
};

