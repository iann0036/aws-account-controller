/*

CreateConnect Event:

{
  "properties": {
    "Domain": "9030bff7"
  }
}

ResetEmail Event:

{
  "email": "example7@yourdomain.com"
}

*/

const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const AWS = require('aws-sdk');
const fs = require('fs');
const url = require('url');
var rp = require('request-promise');
var winston = require('winston');
var InternetMessage = require("internet-message");
var saml2 = require('saml2-js');
var dateFormat = require('dateformat');

var LOG = winston.createLogger({
    level: process.env.LOG_LEVEL.toLowerCase(),
    transports: [
        new winston.transports.Console()
    ]
});

var s3 = new AWS.S3();
var ssm = new AWS.SSM();
var rekognition = new AWS.Rekognition();
var organizations = new AWS.Organizations();
var ses = new AWS.SES();
var eventbridge = new AWS.EventBridge();
var secretsmanager = new AWS.SecretsManager();
var sts = new AWS.STS();
var servicecatalog = new AWS.ServiceCatalog();

const CAPTCHA_KEY = process.env.CAPTCHA_KEY;
const MASTER_EMAIL = process.env.MASTER_EMAIL;
const ACCOUNTID = process.env.ACCOUNTID;

const sendcfnresponse = async (event, context, responseStatus, responseData, physicalResourceId, noEcho) => {
    var responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: "See the details in CloudWatch Log Stream: " + context.logStreamName,
        PhysicalResourceId: physicalResourceId || event.LogicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        NoEcho: noEcho || false,
        Data: responseData
    });
 
    LOG.debug("Response body:\n", responseBody);
 
    var https = require("https");
    var url = require("url");
 
    var parsedUrl = url.parse(event.ResponseURL);
    var options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
            "content-type": "",
            "content-length": responseBody.length
        }
    };
 
    await new Promise((resolve, reject) => {
        var request = https.request(options, function(response) {
            LOG.debug("Status code: " + response.statusCode);
            LOG.debug("Status message: " + response.statusMessage);
            resolve();
        });
     
        request.on("error", function(error) {
            LOG.warn("send(..) failed executing https.request(..): " + error);
            reject();
        });
     
        request.write(responseBody);
        request.end();
    });
}



const solveCaptcha = async (page, url) => {
    var captchaResult = "";

    if (process.env.CAPTCHA_STRATEGY == "Rekognition") {
        captchaResult = await solveCaptchaRekog(page, url);
    } else {
        captchaResult = await solveCaptcha2captcha(page, url);
    }

    return captchaResult;
};

const solveCaptchaRekog = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var code = null;

    let data = await rekognition.detectText({
        Image: {
            Bytes: Buffer.from(imgbody)
        }
    }).promise();

    if (data) {
        data.TextDetections.forEach(textDetection => {
            var text = textDetection.DetectedText.replace(/\ /g, "");
            if (text.length == 6) {
                code = text;
            }
        });
    }

    LOG.debug(code);

    if (!code) {
        await page.click('.refresh');
        await page.waitFor(5000);
    }

    return code;
}

const solveCaptcha2captcha = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var captcharef = await rp({ uri: 'http://2captcha.com/in.php', method: 'POST', body: JSON.stringify({
        'key': CAPTCHA_KEY,
        'method': 'base64',
        'body': "data:image/jpeg;base64," + Buffer.from(imgbody).toString('base64')
    })}).then(res => {
        LOG.debug(res);
        return res.split("|").pop();
    });

    var captcharesult = '';
    var i = 0;
    while (!captcharesult.startsWith("OK") && i < 20) {
        await new Promise(resolve => { setTimeout(resolve, 5000); });

        var captcharesult = await rp({ uri: 'http://2captcha.com/res.php?key=' + CAPTCHA_KEY + '&action=get&id=' + captcharef, method: 'GET' }).then(res => {
            LOG.debug(res);
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
    if (LOG.level == "debug") {
        let filename = Date.now().toString() + ".png";

        await page.screenshot({ path: '/tmp/' + filename });

        await new Promise(function (resolve, reject) {
            fs.readFile('/tmp/' + filename, (err, data) => {
                if (err) LOG.error(err);

                var base64data = Buffer.from(data);

                var params = {
                    Bucket: process.env.DEBUG_BUCKET,
                    Key: filename,
                    Body: base64data
                };

                s3.upload(params, (err, data) => {
                    if (err) LOG.error(`Upload Error ${err}`);
                    LOG.debug('Debug screenshot upload completed - ' + filename);
                    resolve();
                });
            });
        });
    }
};

async function retryWrapper(client, method, params) {
    return new Promise((resolve, reject) => {
        client[method](params).promise().then(data => {
            resolve(data);
        }).catch(err => {
            if (err.code == "TooManyRequestsException") {
                LOG.debug("Got TooManyRequestsException, sleeping 5s");
                setTimeout(() => {
                    retryWrapper(client, method, params).then(data => {
                        resolve(data);
                    }).catch(err => {
                        reject(err);
                    });
                }, 5000); // 5s
            } else if (err.code == "OptInRequired") {
                LOG.debug("Got OptInRequired, sleeping 20s");
                setTimeout(() => {
                    retryWrapper(client, method, params).then(data => {
                        resolve(data);
                    }).catch(err => {
                        reject(err);
                    });
                }, 20000); // 20s
            } else {
                reject(err);
            }
        });
    });
}

async function login(page) {
    let secretsmanagerresponse = await secretsmanager.getSecretValue({
        SecretId: process.env.SECRET_ARN
    }).promise();

    let secretdata = JSON.parse(secretsmanagerresponse.SecretString);

    var passwordstr = secretdata.password;

    await page.goto('https://' + process.env.ACCOUNTID + '.signin.aws.amazon.com/console', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await debugScreenshot(page);

    await page.waitFor(2000);

    let username = await page.$('#username');
    await username.press('Backspace');
    await username.type(secretdata.username, { delay: 100 });

    let password = await page.$('#password');
    await password.press('Backspace');
    await password.type(passwordstr, { delay: 100 });

    await page.click('#signin_button');

    await debugScreenshot(page);

    await page.waitFor(5000);
}

async function createssoapp(page, properties) {
    await page.goto('https://console.aws.amazon.com/singlesignon/home?region=' + process.env.AWS_REGION + '#/applications/add', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    await debugScreenshot(page);

    const cookies = await page.cookies();

    let cookie = "";
    cookies.forEach(cookieitem => {
        cookie += cookieitem['name'] + "=" + cookieitem['value'] + "; ";
    });
    cookie = cookie.substr(0, cookie.length - 2);

    let csrftoken = await page.$eval('head > meta[name="awsc-csrf-token"]', element => element.content);

    let accountmanagergroupresult = await rp({
        uri: 'https://console.aws.amazon.com/singlesignon/api/userpool',
        method: 'POST',
        body: JSON.stringify({
            "method": "POST",
            "path": "/userpool/",
            "headers": {
                "Content-Type": "application/json; charset=UTF-8",
                "Content-Encoding": "amz-1.0",
                "X-Amz-Target": "com.amazonaws.swbup.service.SWBUPService.SearchGroups",
                "X-Amz-Date": dateFormat(new Date(), "GMT:ddd, dd mmm yyyy HH:MM:ss") + " GMT",
                "Accept": "application/json, text/javascript, */*"
            },
            "region": "us-east-1",
            "operation": "SearchGroups",
            "contentString": JSON.stringify({
                "SearchString": "AccountManagerUsers*",
                "SearchAttributes": [
                    "GroupName"
                ],
                "MaxResults": 100,
                "NextToken": null
            })
        }),
        headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-csrf-token': csrftoken,
            'cookie': cookie
        }
    });

    let groupid = null;
    let accountmanagergroups = JSON.parse(accountmanagergroupresult).Groups;
    if (accountmanagergroups.length == 0) {
        let creategroupresult = await rp({
            uri: 'https://console.aws.amazon.com/singlesignon/api/userpool',
            method: 'POST',
            body: JSON.stringify({
                "method": "POST",
                "path": "/userpool/",
                "headers": {
                    "Content-Type": "application/json; charset=UTF-8",
                    "Content-Encoding": "amz-1.0",
                    "X-Amz-Target": "com.amazonaws.swbup.service.SWBUPService.CreateGroup",
                    "X-Amz-Date": dateFormat(new Date(), "GMT:ddd, dd mmm yyyy HH:MM:ss") + " GMT",
                    "Accept": "application/json, text/javascript, */*"
                },
                "region": "us-east-1",
                "operation": "CreateGroup",
                "contentString": JSON.stringify({
                    "GroupName": "AccountManagerUsers"
                })
            }),
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-csrf-token': csrftoken,
                'cookie': cookie
            }
        });

        groupid = JSON.parse(creategroupresult).Group.GroupId;
    } else {
        groupid = accountmanagergroups[0].GroupId;
    }
    
    await page.click('.add-custom-application-text');

    await page.waitFor(5000);

    await debugScreenshot(page);

    let signinurlel = await page.$('awsui-control-group[label="AWS SSO sign-in URL"] > div > div > div > span > div > input');
    properties['SignInURL'] = await page.evaluate((obj) => {
        return obj.value;
    }, signinurlel);

    LOG.debug("Signin URL: " + properties['SignInURL']);

    let signouturlel = await page.$('awsui-control-group[label="AWS SSO sign-out URL"] > div > div > div > span > div > input');
    properties['SignOutURL'] = await page.evaluate((obj) => {
        return obj.value;
    }, signouturlel);

    LOG.debug("Signout URL: " + properties['SignOutURL']);

    await page._client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: '/tmp/'});
    await page.click('awsui-button[click="peregrineMetadata.downloadCertificate()"] > button');

    let appdisplayname = await page.$('awsui-textfield[ng-model="configureApplication.displayName"] > input');
    await page.evaluate((obj) => {
        return obj.value = "";
    }, appdisplayname);
    await appdisplayname.press('Backspace');
    await appdisplayname.type(properties.SSOManagerAppName, { delay: 100 });

    let appdescription = await page.$('awsui-textarea[ng-model="configureApplication.description"] > textarea');
    await page.evaluate((obj) => {
        return obj.value = "";
    }, appdescription);
    await appdescription.press('Backspace');
    await appdescription.type("AWS Accounts Manager", { delay: 100 });

    await page.click('awsui-button[click="configureApplication.toggleServiceProviderConfiguration()"]'); // manual metadata values

    await page.waitFor(200);

    let acsurl = await page.$('awsui-textfield[ng-model="configureApplication.loginURL"] > input');
    await acsurl.press('Backspace');
    await acsurl.type(properties['APIGatewayEndpoint'] + "/", { delay: 100 });
    
    let samlaudience = await page.$('awsui-textfield[ng-model="configureApplication.samlAudience"] > input');
    await samlaudience.press('Backspace');
    await samlaudience.type("https://" + process.env.DOMAIN_NAME + "/metadata.xml", { delay: 100 });

    await debugScreenshot(page);

    await page.click('awsui-button[click="configureApplication.saveChanges()"]'); // save
    
    await page.waitFor(5000);

    fs.readdirSync('/tmp/').forEach(file => {
        if (file.endsWith("certificate.pem")) {
            properties['Certificate'] = fs.readFileSync('/tmp/' + file, 'utf8');
            fs.unlinkSync('/tmp/' + file);
        }
    });

    await debugScreenshot(page);

    await ssm.putParameter({
        Name: process.env.SSO_SSM_PARAMETER,
        Type: "String",
        Value: JSON.stringify(properties),
        Overwrite: true
    }).promise();

    // map attributes
    LOG.debug("Started mapping attributes");

    await debugScreenshot(page);

    let paneltabs = await page.$$('.awsui-tabs-container > li');
    await paneltabs[1].click();

    await page.waitFor(500);

    await debugScreenshot(page);

    await page.click('awsui-select[ng-model="item.schemaProperty.nameIdFormat"]');
    await page.waitFor(200);
    await page.click('li[data-value="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"]');

    let attrmappings = {
        'Subject': '${user:AD_GUID}', // required
        'name': '${user:name}',
        'guid': '${user:AD_GUID}',
        'email': '${user:email}'
    }

    for (const attr in attrmappings) {
        if (attr != "Subject") {
            await page.click('.add-attribute');

            let samlattrnames = await page.$$('awsui-textfield[ng-model="item.key"] > input');
            let samlattrname = samlattrnames.pop();
            await samlattrname.press('Backspace');
            await samlattrname.type(attr, { delay: 100 });
        }

        let samlattrvals = await page.$$('awsui-textfield[ng-model="item.property.source[0]"] > input'); // .ng-invalid-saml-attribute > input
        let samlattrval = samlattrvals.pop();
        await samlattrval.press('Backspace');
        await samlattrval.type(attrmappings[attr], { delay: 100 });

        await page.waitFor(200);
    }

    await debugScreenshot(page);

    await page.click('awsui-button[click="samlSection.saveChanges()"]'); // Save changes

    LOG.debug("Finished mapping attributes, mapping app to group");

    await page.waitFor(5000);

    await paneltabs[2].click(); // users and group mappings
    await page.waitFor(2000);

    await debugScreenshot(page);

    await page.click('.assign-users-button');
    await page.waitFor(5000);

    await debugScreenshot(page);

    let paneltabs2 = await page.$$('.awsui-tabs-container > li');
    await paneltabs2.pop().click(); // last tab
    await page.waitFor(5000);

    await debugScreenshot(page);

    let groupsearch = await page.$('awsui-textfield[ng-model="table.controlValues.search"] > input');
    await groupsearch.press('Backspace');
    await groupsearch.type('AccountManagerUsers', { delay: 100 });
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.click('div.group-name > div.selection > div.checkbox > awsui-checkbox');
    await page.waitFor(200);
    
    await page.click('.assign'); // assign users button

    await page.waitFor(5000);

    await debugScreenshot(page);

    return properties;
}

async function deletessoapp(page, properties) {
    await page.goto('https://console.aws.amazon.com/singlesignon/home?region=' + process.env.AWS_REGION + '#/applications', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    let apptooltip = await page.$$('truncate[tooltip="' + properties.SSOManagerAppName + '"]');
    if (apptooltip.length == 1) {
        await page.evaluate((obj) => {
            return obj.parentNode.parentNode.parentNode.firstElementChild.click();
        }, apptooltip[0]);
        await page.waitFor(200);

        await page.click('awsui-button-dropdown[text="Actions"]');
        await page.waitFor(200);

        let dropdownitems = await page.$$('.awsui-button-dropdown-item-content');
        await dropdownitems.forEach(async (item) => {
            await page.evaluate((obj) => {
                if (obj.innerText.trim() == "Remove") {
                    obj.click();
                }
            }, item);
        });
        await page.waitFor(1000);

        await page.click('.modal-confirm');
        await page.waitFor(6000);

        await debugScreenshot(page);
    } else {
        LOG.warn("Multiple SSO applications of the same name found, skipping");
    }
}

async function createinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/onboarding', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    let directory = await page.$('input[ng-model="ad.directoryAlias"]');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });

    page.focus('button.awsui-button-variant-primary');
    await page.click('button.awsui-button-variant-primary');

    await page.waitForSelector('label.vertical-padding.option-label');
    await page.waitFor(200);
    let skipradio = await page.$$('label.vertical-padding.option-label');
    skipradio.pop().click();

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitForSelector('.onboarding-success-message', {timeout: 180000});

    await debugScreenshot(page);

    await page.waitFor(3000);
}

async function open(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    await page.click('table > tbody > tr > td:nth-child(1) > div > a');

    await page.waitFor(5000);

    let loginbutton = await page.$('.emergency-access a');
    let loginlink = await page.evaluate((obj) => {
        return obj.getAttribute('href');
    }, loginbutton);

    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com' + loginlink, {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitFor(8000);

    await debugScreenshot(page);
}

async function deleteinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    let checkbox = await page.$$('awsui-checkbox > label > input');
    await checkbox[0].click();
    await page.waitFor(200);

    await debugScreenshot(page);
    LOG.debug("Clicked checkbox");

    let removebutton = await page.$$('button[type="submit"]');
    LOG.debug(removebutton.length);
    await removebutton[1].click();
    LOG.debug("Clicked remove");
    await page.waitFor(200);

    let directory = await page.$('.awsui-textfield-type-text');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });
    await page.waitFor(200);

    await page.click('awsui-button[click="confirmDeleteOrg()"] > button');
    await page.waitFor(5000);

    await debugScreenshot(page);
}

async function claimnumber(page, properties) {
    let host = 'https://' + new url.URL(await page.url()).host;

    LOG.debug(host + '/connect/numbers/claim');

    await page.goto(host + '/connect/numbers/claim', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    await page.click('li[heading="DID (Direct Inward Dialing)"] > a');

    await page.waitFor(200);

    await page.click('div.active > span > div.country-code-real-input');

    await page.waitFor(200);

    await page.click('div.active > span.country-code-input.ng-scope > ul > li > .us-flag'); // USA

    await page.waitFor(5000);

    await page.click('div.active > awsui-radio-group > div > span > div:nth-child(1) > awsui-radio-button > label.awsui-radio-button-wrapper-label > div'); // Phone number selection

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

    await page.click('#s2id_select-width > a');
    
    await page.waitFor(2000);

    await debugScreenshot(page);

    let s2input = await page.$('#select2-drop > div > input');
    await s2input.press('Backspace');
    await s2input.type("myFlow", { delay: 100 });
    await page.waitFor(2000);
    await s2input.press('Enter');
    await page.waitFor(1000);

    await debugScreenshot(page);

    await page.click('awsui-button[text="Save"] > button');
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
            await page.goto(host + "/connect/prompts/create", {
                timeout: 0,
                waitUntil: ['domcontentloaded']
            });
            await page.waitFor(5000);
            LOG.info("Checking for correct load");
            LOG.debug(host + "/connect/prompts/create");
        } while (await page.$('#uploadFileBox') === null);

        await debugScreenshot(page);

        const fileInput = await page.$('#uploadFileBox');
        await fileInput.uploadFile(process.env.LAMBDA_TASK_ROOT + '/prompts/' + filename);

        await page.waitFor(1000);

        let input1 = await page.$('#name');
        await input1.press('Backspace');
        await input1.type(filename, { delay: 100 });

        await debugScreenshot(page);

        await page.waitFor(1000);

        await page.click('#lily-save-resource-button');

        await page.waitFor(8000);

        await debugScreenshot(page);
        
        await page.$('#collapsePrompt0 > div > div:nth-child(2) > table > tbody > tr > td');
        let promptid = await page.$eval('#collapsePrompt0 > div > div:nth-child(2) > table > tbody > tr > td', el => el.textContent);
        LOG.debug("PROMPT ID:");
        LOG.debug(promptid);
        ret[filename] = promptid;
    };

    await debugScreenshot(page);

    return ret;
}

async function createflow(page, properties, prompts) {
    let host = 'https://' + new url.URL(await page.url()).host;
    
    do {
        await page.goto(host + "/connect/contact-flows/create?type=contactFlow", {
            timeout: 0,
            waitUntil: ['domcontentloaded']
        });
        await page.waitFor(5000);
        LOG.info("Checking for correct load");
        LOG.debug(host + "/connect/contact-flows/create?type=contactFlow");
    } while (await page.$('#angularContainer') === null);

    await debugScreenshot(page);

    await page.click('#can-edit-contact-flow > div > awsui-button > button');

    await page.waitFor(200);

    await debugScreenshot(page);

    await page.click('#cf-dropdown a[ng-click="verifyImport()"]');

    await page.waitFor(500);

    await page.setBypassCSP(true);

    await debugScreenshot(page);

    let flow = `{
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
                    "value": "8"
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
}`;

    /*fs.writeFileSync("/tmp/flow.json", flow, {
        mode: 0o777
    });*/

    LOG.debug(flow);

    await page.waitFor(5000);

    page.click('#import-cf-file-button');
    let fileinput = await page.$('#import-cf-file');
    LOG.debug(fileinput);
    await page.waitFor(1000);
    await debugScreenshot(page);
    //await fileinput.uploadFile('/tmp/flow.json'); // broken!

    await page.evaluate((flow) => {
        angular.element(document.getElementById('import-cf-file')).scope().importContactFlow(new Blob([flow], {type: "application/json"}));
    }, flow);
    
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.click('.header-button'); // Publish
    await page.waitFor(2000);

    await page.click('awsui-button[text="Publish"] > button'); // Publish modal

    await page.waitFor(8000);

    await debugScreenshot(page);
}

async function loginStage1(page, email) {
    await page.goto('https://console.aws.amazon.com/console/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitForSelector('#resolving_input', {timeout: 15000});
    await page.waitFor(500);

    LOG.debug("Entering email " + email);
    let resolvinginput = await page.$('#resolving_input');
    await resolvinginput.press('Backspace');
    await resolvinginput.type(email, { delay: 100 });

    await page.click('#next_button');

    await debugScreenshot(page);

    await page.waitFor(5000);

    let captchacontainer = await page.$('#captcha_container');
    let captchacontainerstyle = await page.evaluate((obj) => {
        return obj.getAttribute('style');
    }, captchacontainer);

    var captchanotdone = true;
    var captchaattempts = 0;

    if (captchacontainerstyle.includes("display: none")) {
        LOG.debug("Skipping login CAPTCHA");
    } else {
        while (captchanotdone) {
            captchaattempts += 1;
            if (captchaattempts > 6) {
                LOG.error("Failed CAPTCHA too many times, aborting");
                return;
            }
            try {
                let submitc = await page.$('#submit_captcha');

                await debugScreenshot(page);
                let recaptchaimgx = await page.$('#captcha_image');
                let recaptchaurlx = await page.evaluate((obj) => {
                    return obj.getAttribute('src');
                }, recaptchaimgx);

                LOG.debug("CAPTCHA IMG URL:");
                LOG.debug(recaptchaurlx);
                let result = await solveCaptcha(page, recaptchaurlx);

                LOG.debug("CAPTCHA RESULT:");
                LOG.debug(result);

                let input3 = await page.$('#captchaGuess');
                await input3.press('Backspace');
                await input3.type(result, { delay: 100 });

                await debugScreenshot(page);
                await submitc.click();
                await page.waitFor(5000);

                await debugScreenshot(page);

                captchacontainer = await page.$('#captcha_container');
                captchacontainerstyle = await page.evaluate((obj) => {
                    return obj.getAttribute('style');
                }, captchacontainer);

                if (captchacontainerstyle.includes("display: none")) {
                    LOG.debug("Successful CAPTCHA solve");

                    captchanotdone = false;
                }
            } catch (error) {
                LOG.error(error);
            }
        }

        await page.waitFor(5000);
    }
}

async function handleEmailInbound(page, event) {
    for (const record of event['Records']) {
        var account = null;
        var email = '';
        var body = '';
        var isdeletable = false;
        
        let data = await s3.getObject({
            Bucket: record.s3.bucket.name,
            Key: record.s3.object.key
        }).promise();
        
        var msg = InternetMessage.parse(data.Body.toString());

        email = msg.to;
        body = msg.body;

        var emailmatches = /<(.*)>/g.exec(msg.to);
        if (emailmatches && emailmatches.length > 1) {
            email = emailmatches[1];
        }

        data = await retryWrapper(organizations, 'listAccounts', {
            // no params
        });
        let accounts = data.Accounts;
        while (data.NextToken) {
            data = await retryWrapper(organizations, 'listAccounts', {
                NextToken: data.NextToken
            });
    
            accounts = accounts.concat(data.Accounts);
        }
    
        for (const accountitem of accounts) {
            if (accountitem.Email == email) {
                account = accountitem;
            }
        }

        var accountemailforwardingaddress = null;
        var provisionedproductid = null;

        if (account) {
            let orgtags = await retryWrapper(organizations, 'listTagsForResource', { // TODO: paginate
                ResourceId: account.Id
            });

            orgtags.Tags.forEach(tag => {
                if (tag.Key.toLowerCase() == "delete" && tag.Value.toLowerCase() == "true") {
                    isdeletable = true;
                }
                if (tag.Key.toLowerCase() == "accountemailforwardingaddress") {
                    accountemailforwardingaddress = tag.Value;
                }
                if (tag.Key.toLowerCase() == "accountemailforwardingaddress") {
                    accountemailforwardingaddress = tag.Value;
                }
                if (tag.Key.toLowerCase() == "servicecatalogprovisionedproductid") {
                    provisionedproductid = tag.Value;
                }
            });
        }

        let filteredbody = body.replace(/=3D/g, '=').replace(/=\r\n/g, '');

        let start = filteredbody.indexOf("https://signin.aws.amazon.com/resetpassword");
        if (start !== -1) {
            LOG.debug("Started processing password reset");

            let secretsmanagerresponse = await secretsmanager.getSecretValue({
                SecretId: process.env.SECRET_ARN
            }).promise();

            let secretdata = JSON.parse(secretsmanagerresponse.SecretString);

            let end = filteredbody.indexOf("<", start);
            let url = filteredbody.substring(start, end);

            let parsedurl = new URL(url);
            if (parsedurl.host != "signin.aws.amazon.com") { // safety
                throw "Unexpected reset password host";
            }

            if (!account) { // safety
                LOG.debug("No account found, aborting");
                return;
            }

            LOG.debug(url);
            
            await page.goto(url, {
                timeout: 0,
                waitUntil: ['domcontentloaded']
            });
            await page.waitFor(5000);

            await debugScreenshot(page);

            let newpwinput = await page.$('#new_password');
            await newpwinput.press('Backspace');
            await newpwinput.type(secretdata.password, { delay: 100 });

            let input2 = await page.$('#confirm_password');
            await input2.press('Backspace');
            await input2.type(secretdata.password, { delay: 100 });

            await page.click('#reset_password_submit');
            await page.waitFor(5000);

            LOG.info("Completed resetpassword link verification");

            if (isdeletable) {
                LOG.info("Begun delete account");

                if (provisionedproductid) {
                    var terminaterecord = await servicecatalog.terminateProvisionedProduct({
                        TerminateToken: Math.random().toString().substr(2),
                        IgnoreErrors: true,
                        ProvisionedProductId: provisionedproductid
                    }).promise();
                }

                await loginStage1(page, email);

                await debugScreenshot(page);
                
                let input4 = await page.$('#password');
                await input4.press('Backspace');
                await input4.type(secretdata.password, { delay: 100 });

                await debugScreenshot(page);

                await page.click('#signin_button');
                await page.waitFor(8000);
                
                await debugScreenshot(page);

                await page.goto('https://portal.aws.amazon.com/billing/signup?client=organizations&enforcePI=True', {
                    timeout: 0,
                    waitUntil: ['domcontentloaded']
                });
                await page.waitFor(8000);
                
                await debugScreenshot(page);
                LOG.debug("Screenshotted at portal");
                LOG.debug(page.mainFrame().url());
                // /confirmation is an activation period
                if (page.mainFrame().url().split("#").pop() == "/paymentinformation") {

                    let input5 = await page.$('#credit-card-number');
                    await input5.press('Backspace');
                    await input5.type(secretdata.ccnumber, { delay: 100 });

                    await page.select('#expirationMonth', (parseInt(secretdata.ccmonth)-1).toString());

                    await page.waitFor(2000);
                    await debugScreenshot(page);

                    let currentyear = new Date().getFullYear();

                    await page.select('select[name=\'expirationYear\']', (parseInt(secretdata.ccyear)-currentyear).toString());

                    let input6 = await page.$('#accountHolderName');
                    await input6.press('Backspace');
                    await input6.type(secretdata.ccname, { delay: 100 });

                    await page.waitFor(2000);
                    await debugScreenshot(page);

                    await page.click('.form-submit-click-box > button');

                    await page.waitFor(8000);
                }

                await debugScreenshot(page);

                if (page.mainFrame().url().split("#").pop() == "/identityverification") {
                    let usoption = await page.$('option[label="United States (+1)"]');
                    let usvalue = await page.evaluate( (obj) => {
                        return obj.getAttribute('value');
                    }, usoption);

                    await page.select('#countryCode', usvalue);

                    let connectssmparameter = await ssm.getParameter({
                        Name: process.env.CONNECT_SSM_PARAMETER
                    }).promise();

                    let variables = JSON.parse(connectssmparameter['Parameter']['Value']);

                    let portalphonenumber = await page.$('#phoneNumber');
                    await portalphonenumber.press('Backspace');
                    await portalphonenumber.type(variables['PHONE_NUMBER'].replace("+1", ""), { delay: 100 });

                    var phonecode = "";
                    var phonecodetext = "";
                    var captchanotdone = true;
                    var captchaattemptsfordiva = 0;
                    while (captchanotdone) {
                        captchaattemptsfordiva += 1;
                        if (captchaattemptsfordiva > 5) {
                            throw "Could not confirm phone number verification - possible error in DIVA system or credit card";
                        }
                        try {
                            let submitc = await page.$('#btnCall');

                            await debugScreenshot(page);
                            let recaptchaimgx = await page.$('#imageCaptcha');
                            let recaptchaurlx = await page.evaluate((obj) => {
                                return obj.getAttribute('src');
                            }, recaptchaimgx);

                            LOG.debug("CAPTCHA IMG URL:");
                            LOG.debug(recaptchaurlx);
                            let result = await solveCaptcha(page, recaptchaurlx);

                            LOG.debug("CAPTCHA RESULT:");
                            LOG.debug(result);

                            let input32 = await page.$('#guess');
                            await input32.press('Backspace');
                            await input32.type(result, { delay: 100 });

                            await debugScreenshot(page);
                            await submitc.click();
                            await page.waitFor(5000);

                            await debugScreenshot(page);

                            await page.waitForSelector('.phone-pin-number', {timeout: 5000});

                            phonecode = await page.$('.phone-pin-number > span');
                            phonecodetext = await page.evaluate(el => el.textContent, phonecode);

                            if (phonecodetext.trim().length == 4) {
                                captchanotdone = false;
                            } else {
                                await page.waitFor(5000);
                            }
                        } catch (error) {
                            LOG.error(error);
                        }
                    }

                    await debugScreenshot(page);
                                
                    variables['CODE'] = phonecodetext;
    
                    await ssm.putParameter({
                        Name: process.env.CONNECT_SSM_PARAMETER,
                        Type: "String",
                        Value: JSON.stringify(variables),
                        Overwrite: true
                    }).promise();

                    await page.waitFor(30000);
                    
                    await debugScreenshot(page);

                    try {
                        await page.click('#verification-complete-button');
                    } catch(err) {
                        LOG.error("Could not confirm phone number verification - possible error in DIVA system or credit card");
                        throw err;
                    }

                    await page.waitFor(3000);
                    
                    await debugScreenshot(page);

                }

                if (page.mainFrame().url().split("#").pop() == "/support" || page.mainFrame().url().split("#").pop() == "/confirmation") {
                    await page.goto('https://console.aws.amazon.com/billing/rest/v1.0/account', {
                        timeout: 0,
                        waitUntil: ['domcontentloaded']
                    });

                    await page.waitFor(3000);

                    await debugScreenshot(page);

                    let accountstatuspage = await page.content();

                    LOG.debug(accountstatuspage);

                    let issuspended = accountstatuspage.includes("\"accountStatus\":\"Suspended\"");

                    if (provisionedproductid) {
                        let terminatestatus = "CREATED";
                        while (['CREATED', 'IN_PROGRESS'].includes(terminatestatus)) {
                            await new Promise((resolve) => {setTimeout(resolve, 10000)});

                            let record = await servicecatalog.describeRecord({
                                Id: terminaterecord.RecordDetail.RecordId
                            }).promise();
                            terminatestatus = record.RecordDetail.Status;
                        }
                        if (terminatestatus != "SUCCEEDED") {
                            throw "Could not terminate product from Service Catalog";
                        }
                    }

                    if (!issuspended) {
                        await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
                            timeout: 0,
                            waitUntil: ['domcontentloaded']
                        });

                        await page.waitFor(8000);

                        await debugScreenshot(page);

                        let closeaccountcbs = await page.$$('.close-account-checkbox > input');
                        await closeaccountcbs.forEach(async (cb) => {
                            await cb.click();
                        });

                        await page.waitFor(1000);

                        await debugScreenshot(page);

                        await page.click('.btn-danger'); // close account button

                        await page.waitFor(1000);

                        await debugScreenshot(page);

                        await page.click('.modal-footer > button.btn-danger'); // confirm close account button

                        await page.waitFor(5000);

                        await debugScreenshot(page);

                        await retryWrapper(organizations, 'tagResource', {
                            ResourceId: account.Id,
                            Tags: [{
                                Key: "AccountDeletionTime",
                                Value: (new Date()).toISOString()
                            }]
                        });
                    }

                    await removeAccountFromOrg(account);
                } else {
                    LOG.warn("Unsure of location, send help! - " + page.mainFrame().url());
                }
            }
            
        } else {
            LOG.debug("No password reset found, forwarding e-mail");

            await new Promise(async (resolve, reject) => {
                var accountid = "?";
                var accountemail = "?";
                var accountname= "?";
                if (account) {
                    accountid = account.Id || "?";
                    accountemail = account.Email || "?";
                    accountname = account.Name || "?";
                }
                var msgsubject = msg.subject || "";
                var from = msg.from || "";
                var to = msg.to || "";
    
                msg.subject = process.env.EMAIL_SUBJECT.
                    replace("{subject}", msgsubject).
                    replace("{from}", from).
                    replace("{to}", to).
                    replace("{accountid}", accountid).
                    replace("{accountname}", accountname).
                    replace("{accountemail}", accountemail);
    
                msg.to = accountemailforwardingaddress || "AWS Accounts Master <" + MASTER_EMAIL + ">";
                msg.from = "AWS Accounts Master <" + MASTER_EMAIL + ">";
                msg['return-path'] = "AWS Accounts Master <" + MASTER_EMAIL + ">";
    
                var stringified = InternetMessage.stringify(msg);
                
                ses.sendRawEmail({
                    Source: MASTER_EMAIL,
                    Destinations: [msg.to],
                    RawMessage: {
                        Data: stringified
                    }
                }, async function (err, data) {
                    if (err) {
                        LOG.debug(err);
    
                        msg.to = "AWS Accounts Master <" + MASTER_EMAIL + ">";
                        
                        await ses.sendRawEmail({
                            Source: MASTER_EMAIL,
                            Destinations: [MASTER_EMAIL],
                            RawMessage: {
                                Data: "To: " + msg.to + "\r\nFrom: " + msg.from + "\r\nSubject: " + msg.subject + "\r\n\r\n***CONTENT NOT PROCESSABLE***\r\n\r\nDownload the email from s3://" + record.s3.bucket.name + "/" + record.s3.object.key + "\r\n"
                            }
                        }).promise();
                    }
    
                    resolve();
                });
            });
        }
    }
    
    return true;
};

async function removeAccountFromOrg(account) {
    var now = new Date();
    var threshold = new Date(account.JoinedTimestamp);
    threshold.setDate(threshold.getDate() + 7); // 7 days
    if (now > threshold) {
        await retryWrapper(organizations, 'removeAccountFromOrganization', {
            AccountId: account.Id
        });

        LOG.info("Removed account from Org");

        return true;
    } else {
        threshold.setMinutes(threshold.getMinutes() + 2); // plus 2 minutes buffer
        await eventbridge.putRule({
            Name: "ScheduledAccountDeletion-" + account.Id.toString(),
            Description: "The scheduled deletion of an Organizations account",
            //RoleArn: '',
            ScheduleExpression: "cron(" + threshold.getMinutes() + " " + threshold.getUTCHours() + " " + threshold.getUTCDate() + " " + (threshold.getUTCMonth() + 1) + " ? " + threshold.getUTCFullYear() + ")",
            State: "ENABLED"
        }).promise();

        await eventbridge.putTargets({
            Rule: "ScheduledAccountDeletion-" + account.Id.toString(),
            Targets: [{
                Arn: "arn:aws:lambda:" + process.env.AWS_REGION + ":" + process.env.ACCOUNTID  + ":function:" + process.env.AWS_LAMBDA_FUNCTION_NAME,
                Id: "Lambda",
                //RoleArn: "",
                Input: JSON.stringify({
                    "action": "removeAccountFromOrg",
                    "account": account,
                    "ruleName": "ScheduledAccountDeletion-" + account.Id.toString()
                })
            }]
        }).promise();

        await retryWrapper(organizations, 'tagResource', {
            ResourceId: account.Id,
            Tags: [{
                Key: "ScheduledRemovalTime",
                Value: threshold.toISOString()
            }]
        });

        LOG.info("Scheduled removal for later");
    }

    return false;
}

async function triggerReset(page, event) {
    await loginStage1(page, event.email);
    
    await debugScreenshot(page);

    await page.click('#root_forgot_password_link');

    await page.waitFor(2000);

    await page.waitForSelector('#password_recovery_captcha_image', {timeout: 15000});

    captchanotdone = true;
    captchaattempts = 0;
    while (captchanotdone) {
        captchaattempts += 1;
        if (captchaattempts > 6) {
            LOG.error("Failed CAPTCHA too many times, aborting");
            return;
        }

        await debugScreenshot(page);

        let recaptchaimg = await page.$('#password_recovery_captcha_image');
        let recaptchaurl = await page.evaluate((obj) => {
            return obj.getAttribute('src');
        }, recaptchaimg);

        LOG.debug(recaptchaurl);
        let captcharesult = await solveCaptcha(page, recaptchaurl);

        let input2 = await page.$('#password_recovery_captcha_guess');
        await input2.press('Backspace');
        await input2.type(captcharesult, { delay: 100 });

        await page.waitFor(3000);

        await debugScreenshot(page);

        await page.click('#password_recovery_ok_button');

        await page.waitFor(5000);

        let errormessagediv = await page.$('#password_recovery_error_message');
        let errormessagedivstyle = await page.evaluate((obj) => {
            return obj.getAttribute('style');
        }, errormessagediv);
        
        if (errormessagedivstyle.includes("display: none")) {
            captchanotdone = false;
        }
    }

    await debugScreenshot(page);

    await page.waitFor(2000);
};

async function addSubscriptionsSCP(details) {
    LOG.info("Adding subscriptions SCP");

    let rolename = 'OrganizationAccountAccessRole';
    if (process.env.CONTROL_TOWER_MODE == "true") {
        rolename = 'AWSControlTowerExecution';
    }

    let policyid = null;
    let policiesdata = await retryWrapper(organizations, 'listPolicies', {
        Filter: 'SERVICE_CONTROL_POLICY'
    });
    let policies = policiesdata.Policies;

    while (policiesdata.NextToken) {
        policiesdata = await retryWrapper(organizations, 'listPolicies', {
            Filter: 'SERVICE_CONTROL_POLICY',
            NextToken: policiesdata.NextToken
        });
        policies.concat(policiesdata.Policies);
    }

    policyid = null;

    for (const policy of policies) {
        if (policy.Name == "AccountManagerDenySubscriptionCalls") {
            policyid = policy.Id;
        }
    }
    
    if (!policyid) {
        policydata = await retryWrapper(organizations, 'createPolicy', {
            Content: JSON.stringify({
                Version: "2012-10-17",
                Statement: {
                    Effect: "Deny",
                    Action: [
                        "route53domains:RegisterDomain",
                        "route53domains:RenewDomain",
                        "route53domains:TransferDomain",
                        "ec2:ModifyReservedInstances",
                        "ec2:PurchaseHostReservation",
                        "ec2:PurchaseReservedInstancesOffering",
                        "ec2:PurchaseScheduledInstances",
                        "rds:PurchaseReservedDBInstancesOffering",
                        "dynamodb:PurchaseReservedCapacityOfferings",
                        "s3:PutObjectRetention",
                        "s3:PutObjectLegalHold",
                        "s3:BypassGovernanceRetention",
                        "s3:PutBucketObjectLockConfiguration",
                        "elasticache:PurchaseReservedCacheNodesOffering",
                        "redshift:PurchaseReservedNodeOffering",
                        "savingsplans:CreateSavingsPlan",
                        "aws-marketplace:AcceptAgreementApprovalRequest",
                        "aws-marketplace:Subscribe"
                    ],
                    Resource: "*",
                    Condition: {
                        StringNotLike: {
                            'aws:PrincipalArn': 'arn:aws:iam::*:role/' + rolename
                        }
                    }
                }
            }),
            Description: 'Used to restrict access to create long-term subscriptions',
            Name: 'AccountManagerDenySubscriptionCalls',
            Type: 'SERVICE_CONTROL_POLICY'
        });
        
        policyid = policydata.Policy.PolicySummary.Id;
    } else {
        await retryWrapper(organizations, 'updatePolicy', {
            Content: JSON.stringify({
                Version: "2012-10-17",
                Statement: {
                    Effect: "Deny",
                    Action: [
                        "route53domains:RegisterDomain",
                        "route53domains:RenewDomain",
                        "route53domains:TransferDomain",
                        "ec2:ModifyReservedInstances",
                        "ec2:PurchaseHostReservation",
                        "ec2:PurchaseReservedInstancesOffering",
                        "ec2:PurchaseScheduledInstances",
                        "rds:PurchaseReservedDBInstancesOffering",
                        "dynamodb:PurchaseReservedCapacityOfferings",
                        "s3:PutObjectRetention",
                        "s3:PutObjectLegalHold",
                        "s3:BypassGovernanceRetention",
                        "s3:PutBucketObjectLockConfiguration",
                        "elasticache:PurchaseReservedCacheNodesOffering",
                        "redshift:PurchaseReservedNodeOffering",
                        "savingsplans:CreateSavingsPlan",
                        "aws-marketplace:AcceptAgreementApprovalRequest",
                        "aws-marketplace:Subscribe"
                    ],
                    Resource: "*",
                    Condition: {
                        StringNotLike: {
                            'aws:PrincipalArn': 'arn:aws:iam::*:role/' + rolename
                        }
                    }
                }
            }),
            PolicyId: policyid
        }).catch(() => {});
    }

    await retryWrapper(organizations, 'attachPolicy', {
        PolicyId: policyid,
        TargetId: details['accountid']
    }).catch(err => {
        if (err.code == "DuplicatePolicyAttachmentException") {
            LOG.info("Skipping attach subscription SCP, already attached");
        } else {
            throw err;
        }
    });
}

async function addBillingMonitor(page, details) {
    LOG.info("Adding billing monitor");
    
    let rolename = 'OrganizationAccountAccessRole';
    if (process.env.CONTROL_TOWER_MODE == "true") {
        rolename = 'AWSControlTowerExecution';
    }

    let assumedrole = await sts.assumeRole({
        RoleArn: 'arn:aws:iam::' + details['accountid'] + ':role/' + rolename,
        RoleSessionName: 'AccountManagerAddBillingMonitor'
    }).promise();

    let policyid = null;
    let policiesdata = await retryWrapper(organizations, 'listPolicies', {
        Filter: 'SERVICE_CONTROL_POLICY'
    });
    let policies = policiesdata.Policies;

    while (policiesdata.NextToken) {
        policiesdata = await retryWrapper(organizations, 'listPolicies', {
            Filter: 'SERVICE_CONTROL_POLICY',
            NextToken: policiesdata.NextToken
        });
        policies.concat(policiesdata.Policies);
    }

    for (const policy of policies) {
        if (policy.Name == "AccountManagerDenyBillingAlarmAccess") {
            policyid = policy.Id;
        }
    }
    
    if (!policyid) {
        policydata = await retryWrapper(organizations, 'createPolicy', {
            Content: JSON.stringify({
                Version: "2012-10-17",
                Statement: {
                    Effect: "Deny",
                    Action: "*",
                    Resource: "arn:aws:cloudwatch:us-east-1:*:alarm:AccountManagerDeletionBudgetMonitor",
                    Condition: {
                        StringNotLike: {
                            'aws:PrincipalArn': 'arn:aws:iam::*:role/' + rolename
                        }
                    }
                }
            }),
            Description: 'Used to restrict access to the billing alarm',
            Name: 'AccountManagerDenyBillingAlarmAccess',
            Type: 'SERVICE_CONTROL_POLICY'
        });
        
        policyid = policydata.Policy.PolicySummary.Id;
    } else {
        await retryWrapper(organizations, 'updatePolicy', {
            Content: JSON.stringify({
                Version: "2012-10-17",
                Statement: {
                    Effect: "Deny",
                    Action: "*",
                    Resource: "arn:aws:cloudwatch:us-east-1:*:alarm:AccountManagerDeletionBudgetMonitor",
                    Condition: {
                        StringNotLike: {
                            'aws:PrincipalArn': 'arn:aws:iam::*:role/' + rolename
                        }
                    }
                }
            }),
            PolicyId: policyid
        }).catch(() => { });
    }

    await retryWrapper(organizations, 'attachPolicy', {
        PolicyId: policyid,
        TargetId: details['accountid']
    }).catch(err => {
        if (err.code == "DuplicatePolicyAttachmentException") {
            LOG.info("Skipping attach billing SCP, already attached");
        } else {
            throw err;
        }
    });

    //await new Promise((resolve) => {setTimeout(resolve, 120000)}); // wait for account active

    let childcloudwatch = new AWS.CloudWatch({
        accessKeyId: assumedrole.Credentials.AccessKeyId,
        secretAccessKey: assumedrole.Credentials.SecretAccessKey,
        sessionToken: assumedrole.Credentials.SessionToken
    });

    let alarm = await retryWrapper(childcloudwatch, 'putMetricAlarm', {
        AlarmName: 'AccountManagerDeletionBudgetMonitor',
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        ActionsEnabled: true,
        AlarmActions: [
            process.env.ACCOUNT_DELETION_TOPIC
        ],
        AlarmDescription: 'Sends a request to delete this account to the account manager when the budget is reached',
        DatapointsToAlarm: 1,
        Dimensions: [{
            Name: 'Currency',
            Value: 'USD'
        }],
        MetricName: 'EstimatedCharges',
        Namespace: 'AWS/Billing',
        Period: 21600,
        Statistic: 'Maximum',
        Threshold: details['budgetthresholdbeforedeletion'],
        TreatMissingData: 'ignore',
        Unit: 'None'
    }); // subject to OptInRequired

    LOG.debug(alarm);
    LOG.info("Completed adding billing monitor");
}

async function setSSOOwner(page, details) {
    let ssoparamresponse = await ssm.getParameter({
        Name: process.env.SSO_SSM_PARAMETER
    }).promise();

    let ssoproperties = JSON.parse(ssoparamresponse['Parameter']['Value']);

    await page.goto('https://console.aws.amazon.com/singlesignon/home?region=' + process.env.AWS_REGION + '#/accounts/organization/assignUsers?ids=' + details['accountid'] + '&step=userGroupsStep', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitFor(5000);

    await debugScreenshot(page);

    const cookies = await page.cookies();

    let cookie = "";
    cookies.forEach(cookieitem => {
        cookie += cookieitem['name'] + "=" + cookieitem['value'] + "; ";
    });
    cookie = cookie.substr(0, cookie.length - 2);

    let csrftoken = await page.$eval('head > meta[name="awsc-csrf-token"]', element => element.content);

    //--//
    
    let directoryConfig = await rp({
        uri: 'https://console.aws.amazon.com/singlesignon/api/peregrine',
        method: 'POST',
        body: JSON.stringify({
            "method": "POST",
            "path": "/control/",
            "headers": {
                "Content-Type": "application/json; charset=UTF-8",
                "Content-Encoding": "amz-1.0",
                "X-Amz-Target": "com.amazon.switchboard.service.SWBService.ListDirectoryAssociations",
                "X-Amz-Date": dateFormat(new Date(), "GMT:ddd, dd mmm yyyy HH:MM:ss") + " GMT",
                "Accept": "application/json, text/javascript, */*"
            },
            "region": "us-east-1",
            "operation": "ListDirectoryAssociations",
            "contentString": JSON.stringify({
                "marker": null
            })
        }),
        headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-csrf-token': csrftoken,
            'cookie': cookie
        }
    });

    let primaryDirectoryId = JSON.parse(directoryConfig).directoryAssociations[0].directoryId;

    let userConfig = await rp({
        uri: 'https://console.aws.amazon.com/singlesignon/api/identitystore',
        method: 'POST',
        body: JSON.stringify({
            "method": "POST",
            "path": "/identitystore/",
            "headers": {
                "Content-Type": "application/json; charset=UTF-8",
                "Content-Encoding": "amz-1.0",
                "X-Amz-Target": "com.amazonaws.identitystore.AWSIdentityStoreService.DescribeUsers",
                "X-Amz-Date": "Wed, 08 Apr 2020 02:22:19 GMT",
                "Accept": "application/json, text/javascript, */*"
            },
            "region":"us-east-1",
            "operation":"DescribeUsers",
            "contentString": JSON.stringify({
                "IdentityStoreId": primaryDirectoryId,
                "UserIds": [
                    details['accountowner']
                ]
            })
        }),
        headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-csrf-token': csrftoken,
            'cookie': cookie
        }
    });

    let username = JSON.parse(userConfig).Users[0].UserName;

    await page.click('awsui-select[ng-model="table.controlValues.selectedSearchValue"]');
    await page.waitFor(200);

    await page.click('li[data-value="userName"]');
    await page.waitFor(200);

    await debugScreenshot(page);

    let usernamesearch = await page.$('awsui-textfield[ng-model="table.controlValues.search"] > input');
    await usernamesearch.press('Backspace');
    await usernamesearch.type(username, { delay: 100 });

    await page.waitFor(5000);

    await page.click('.select-all > .checkbox > awsui-checkbox');
    await page.waitFor(200);

    await debugScreenshot(page);

    if (details['isshared']) {
        LOG.debug("Sharing account with group");

        let paneltabs = await page.$$('.awsui-tabs-tab > a');
        await paneltabs[1].click();
        await page.waitFor(5000);

        await debugScreenshot(page);
        
        let groupsearch = await page.$('input[placeholder="Find groups by name"]'); // TODO: use a better selector
        await groupsearch.press('Backspace');
        await groupsearch.type('AccountManagerUsers', { delay: 100 });
        await page.waitFor(5000);

        await debugScreenshot(page);
        
        await page.click('div.group-name > div.selection > div.checkbox > awsui-checkbox');
        await page.waitFor(200);

        await debugScreenshot(page);
    }

    await page.click('.wizard-next-button');
    await page.waitFor(3000);

    let adminlabel = await page.$('div.cell-content > truncate[tooltip="AdministratorAccess"]');
    await page.evaluate((obj) => {
        obj.parentNode.parentNode.querySelector('div.selection > div.checkbox > awsui-checkbox').click();
    }, adminlabel);
    await page.waitFor(200);

    await page.click('.wizard-next-button');
    await page.waitFor(10000);

    await debugScreenshot(page);

    await retryWrapper(organizations, 'tagResource', {
        ResourceId: details['accountid'],
        Tags: [{
            Key: "SSOCreationComplete",
            Value: "true"
        }]
    });
}

async function decodeSAMLResponse(sp, idp, samlresponse) {
    let resp = await new Promise((resolve,reject) => {
        sp.post_assert(idp, {
            request_body: {
                'SAMLResponse': samlresponse
            }
        }, function(err, resp) {
            if (err) {
                reject(err);
            } else {
                resolve(resp);
            }
        });
    });
    
    return resp;
}

function decodeForm(form) {
    var ret = {};

    var items = form.split("&");
    items.forEach(item => {
        var split = item.split("=");
        ret[split.shift()] = split.join("=");
    });

    return ret
}

async function getUserBySAML(samlresponse) {
    let ssoparamresponse = await ssm.getParameter({
        Name: process.env.SSO_SSM_PARAMETER
    }).promise();

    let ssoproperties = JSON.parse(ssoparamresponse['Parameter']['Value']);
    
    var sp_options = {
        entity_id: "https://" + process.env.DOMAIN_NAME + "/metadata.xml",
        private_key: "",
        certificate: "",
        assert_endpoint: "",
        allow_unencrypted_assertion: true
    };
    var sp = new saml2.ServiceProvider(sp_options);
    
    var idp_options = {
        sso_login_url: ssoproperties['SignInURL'],
        sso_logout_url: ssoproperties['SignOutURL'],
        certificates: [ssoproperties['Certificate']],
        allow_unencrypted_assertion: true
    };
    var idp = new saml2.IdentityProvider(idp_options);

    let samlattrs = await decodeSAMLResponse(sp, idp, decodeURIComponent(samlresponse));

    return {
        'name': samlattrs['user']['attributes']['name'][0],
        'email': samlattrs['user']['attributes']['email'][0],
        'guid': samlattrs['user']['attributes']['guid'][0],
        'samlresponse': decodeURIComponent(samlresponse),
        'ssoprops': ssoproperties
    };
}

async function handleSAMLResponse(event) {
    let body = event.body;
    if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf8');
    }

    var form = decodeForm(body);

    let user = await getUserBySAML(form['SAMLResponse']);

    return {
        "statusCode": 200,
        "isBase64Encoded": false,
        "headers": {
            "Content-Type": "text/html"
        },
        "body": wrapHTML(user)
    };
}

async function handleGetAccounts(event) {
    let body = event.body;
    if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf8');
    }

    var form = decodeForm(body);

    let user = await getUserBySAML(form['SAMLResponse']);

    let useraccounts = [];

    let data = await retryWrapper(organizations, 'listAccounts', {
        // no params
    });
    let accounts = data.Accounts;
    while (data.NextToken) {
        let moreaccounts = await retryWrapper(organizations, 'listAccounts', {
            NextToken: data.NextToken
        });

        accounts = accounts.concat(moreaccounts.Accounts);
    }

    for (const account of accounts) {
        let tags = await retryWrapper(organizations, 'listTagsForResource', { // TODO: paginate
            ResourceId: account.Id
        });

        let shouldAddToUserAccountsList = false;
        let isdeleted = false;
        let useraccount = {
            'Id': account.Id,
            'Email': account.Email,
            'JoinedTimestamp': account.JoinedTimestamp,
            'Name': account.Name
        };
        for (const tag of tags.Tags) {
            if (tag.Key.toLowerCase() == "notes") {
                useraccount['Notes'] = tag.Value.replace(/\+/g, " ");
            }
            if (tag.Key.toLowerCase() == "delete" && tag.Value.toLowerCase() == "true") {
                useraccount['IsDeleting'] = true;
            }
            if (tag.Key.toLowerCase() == "ssocreationcomplete" && tag.Value.toLowerCase() == "false") {
                useraccount['IsCreating'] = true;
            }
            if (tag.Key.toLowerCase() == "accountownerguid" && tag.Value == user.guid) {
                shouldAddToUserAccountsList = true;
                useraccount['IsOwner'] = true;
            }
            if (tag.Key.toLowerCase() == "sharedwithorg" && tag.Value.toLowerCase() == "true") {
                shouldAddToUserAccountsList = true;
                useraccount['IsShared'] = true;
            }
            if (tag.Key.toLowerCase() == "scheduledremovaltime") {
                isdeleted = true;
            }
        }
        if (shouldAddToUserAccountsList && !isdeleted) { // ignore deleting, suspended accounts (deferred org removal)
            useraccounts.push(useraccount);
        }
    }

    useraccounts.sort(function(x, y) {
        return y.JoinedTimestamp - x.JoinedTimestamp;
    });

    return {
        "statusCode": 200,
        "isBase64Encoded": false,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": JSON.stringify({
            'accounts': useraccounts
        })
    };
}

async function processSnsDeleteAccount(event) {
    for (const record of event['Records']) {
        if (record.EventSubscriptionArn.startsWith(process.env.ACCOUNT_DELETION_TOPIC)) {
            let snsmessage = JSON.parse(record.Sns.Message);

            let accountid = snsmessage.AWSAccountId;

            let account = await retryWrapper(organizations, 'describeAccount', {
                AccountId: accountid
            });

            LOG.info("Deleting account " + accountid + " due to budget alert");

            await retryWrapper(organizations, 'tagResource', {
                ResourceId: account.Account.Id,
                Tags: [{
                    Key: "Delete",
                    Value: "true"
                }]
            });
        }
    }
}

async function handleDeleteAccountRequest(event) {
    let body = event.body;
    if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf8');
    }

    var form = decodeForm(body);

    let user = await getUserBySAML(form['SAMLResponse']);

    let account = await retryWrapper(organizations, 'describeAccount', {
        AccountId: form['accountid']
    }).catch(err => {
        LOG.debug(err);

        return {
            "statusCode": 404,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                'deleteAccountSuccess': false
            })
        };
    });
    
    let tagdata = await retryWrapper(organizations, 'listTagsForResource', {
        ResourceId: account.Account.Id
    });

    for (const tag of tagdata.Tags) {
        if (tag.Key.toLowerCase() == "accountownerguid" && tag.Value == user.guid) {
            await retryWrapper(organizations, 'tagResource', {
                ResourceId: account.Account.Id,
                Tags: [{
                    Key: "Delete",
                    Value: "true"
                }]
            });

            return {
                "statusCode": 200,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'deleteAccountSuccess': true
                })
            };
        }
    }

    return {
        "statusCode": 403,
        "isBase64Encoded": false,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": JSON.stringify({
            'deleteAccountSuccess': false
        })
    };
}

async function handleCreateAccountRequest(event) {
    let body = event.body;
    if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf8');
    }

    var form = decodeForm(body);

    let user = await getUserBySAML(form['SAMLResponse']);

    let accountemail = decodeURIComponent(form['emailprefix'].replace(/\+/g, ' ')) + "@" + process.env.DOMAIN_NAME;
    let accountname = decodeURIComponent(form['accountname'].replace(/\+/g, ' '));
    let notes = decodeURIComponent(form['notes'].replace(/\ /g, '+'));
    let maximumspend = "";
    if (form['maximumspend']) {
        maximumspend = decodeURIComponent(form['maximumspend']);
    }

    if (!accountname.match(/^.{1,50}$/g)) {
        return {
            "statusCode": 400,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                'createAccountSuccess': false,
                'reason': 'Please enter an account name that is from 1 to 50 characters long'
            })
        };
    }

    if (!accountemail.match(/^.{6,64}$/g)) {
        return {
            "statusCode": 400,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                'createAccountSuccess': false,
                'reason': 'Please enter a valid email address that is from 6 to 64 characters long'
            })
        };
    }

    if (!notes.match(/^[a-zA-Z0-9\.\:\+\=@_\/\-]{0,256}$/g)) {
        return {
            "statusCode": 400,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                'createAccountSuccess': false,
                'reason': 'The notes field can have up to 256 characters (valid characters: a-z, A-Z, 0-9, and . : = @ _ / - <space> )'
            })
        };
    }

    if (process.env.MAXIMUM_ACCOUNT_SPEND != "0") {
        if (!maximumspend.match(/^[0-9]+(?:\.[0-9]{2})?$/g)) {
            return {
                "statusCode": 400,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'createAccountSuccess': false,
                    'reason': 'The maximum spend field must be a number'
                })
            };
        }
        
        maximumspend = parseFloat(maximumspend);
        if (maximumspend <= 0) {
            return {
                "statusCode": 400,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'createAccountSuccess': false,
                    'reason': 'The maximum spend field must be greater than zero'
                })
            };
        }
        if (maximumspend > parseFloat(process.env.MAXIMUM_ACCOUNT_SPEND)) {
            return {
                "statusCode": 400,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'createAccountSuccess': false,
                    'reason': 'The maximum spend field must not be greater than ' + process.env.MAXIMUM_ACCOUNT_SPEND
                })
            };
        }
    }

    let accountid = null;
    let provisionaccountfromproductop = null;
    if (process.env.CONTROL_TOWER_MODE == "true") {
        let productslist = await servicecatalog.searchProductsAsAdmin({
            Filters: {
                FullTextSearch: ['AWS Control Tower Account Factory']
            }
        }).promise();

        if (productslist.ProductViewDetails.length != 1) {
            return {
                "statusCode": 503,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'createAccountSuccess': false,
                    'reason': 'Could not find Account Factory product'
                })
            };
        }
        
        let portfoliolist = await servicecatalog.listPortfoliosForProduct({
            ProductId: productslist.ProductViewDetails[0].ProductViewSummary.ProductId
        }).promise();

        for (let portfolio of portfoliolist.PortfolioDetails) {
            if (portfolio.DisplayName == "AWS Control Tower Account Factory Portfolio") {
                await servicecatalog.associatePrincipalWithPortfolio({
                    PortfolioId: portfolio.Id,
                    PrincipalType: 'IAM',
                    PrincipalARN: process.env.ROLE
                }).promise().then(async () => {
                    await new Promise((resolve) => {setTimeout(resolve, 2000)}); // eventual consistency issues
                }).catch(err => {});
            }
        }

        let artifactlist = await servicecatalog.listProvisioningArtifacts({
            ProductId: productslist.ProductViewDetails[0].ProductViewSummary.ProductId
        }).promise();

        let pathlist = await servicecatalog.listLaunchPaths({
            ProductId: productslist.ProductViewDetails[0].ProductViewSummary.ProductId
        }).promise();

        provisionaccountfromproductop = await servicecatalog.provisionProduct({
            PathId: pathlist.LaunchPathSummaries[0].Id,
            ProductId: productslist.ProductViewDetails[0].ProductViewSummary.ProductId,
            ProvisionToken: Math.random().toString().substr(2),
            ProvisionedProductName: "account-" + dateFormat(new Date(), "yyyy-mm-dd-HH-MM-ss-") + Math.random().toString().substr(2,8),
            ProvisioningArtifactId: artifactlist.ProvisioningArtifactDetails.pop().Id,
            ProvisioningParameters: [
                {
                    Key: 'SSOUserEmail',
                    Value: user.email
                },
                {
                    Key: 'AccountEmail',
                    Value: accountemail
                },
                {
                    Key: 'SSOUserFirstName',
                    Value: user.name.split(" ")[0]
                },
                {
                    Key: 'SSOUserLastName',
                    Value: user.name.split(" ").pop()
                },
                {
                    Key: 'ManagedOrganizationalUnit',
                    Value: 'Custom'
                },
                {
                    Key: 'AccountName',
                    Value: accountname
                },
            ]
        }).promise().catch(err => {
            LOG.debug(err);
        });

        let accountsdata = [];
        let accounts = [];

        while (!accountid) {
            await new Promise((resolve) => {setTimeout(resolve, 2000)});

            accountsdata = await retryWrapper(organizations, 'listAccounts', {
                // no params
            });
            
            accounts = accountsdata.Accounts;
            
            while (accountsdata.NextToken) {
                accountsdata = await retryWrapper(organizations, 'listAccounts', {
                    NextToken: data.NextToken
                });
                accounts = accounts.concat(accountsdata.Accounts);
            }
            for (let account of accounts) {
                if (account.Email == accountemail) {
                    accountid = account.Id;
                }
            }
        }
    } else {
        let createaccountop = await retryWrapper(organizations, 'createAccount', {
            AccountName: accountname, 
            Email: accountemail,
            IamUserAccessToBilling: 'ALLOW',
            RoleName: 'OrganizationAccountAccessRole'
        });

        LOG.debug("Created account, waiting for state");

        while (createaccountop.CreateAccountStatus.State == "IN_PROGRESS") {
            LOG.debug("Account creation still in progress...");
            await new Promise((resolve) => {setTimeout(resolve, 2000)});

            createaccountop = await retryWrapper(organizations, 'describeCreateAccountStatus', {
                CreateAccountRequestId: createaccountop.CreateAccountStatus.Id
            });
        }

        if (createaccountop.CreateAccountStatus.State != "SUCCEEDED") {
            LOG.debug("Account creation failure");
            LOG.debug(createaccountop);

            let reason = 'The account could not be created for an unknown reason';
            if (createaccountop.CreateAccountStatus.FailureReason == "ACCOUNT_LIMIT_EXCEEDED") {
                reason = 'The account could not be created because the Organizational limit has been exceeded';
            } else if (createaccountop.CreateAccountStatus.FailureReason == "EMAIL_ALREADY_EXISTS") {
                reason = 'The account could not be created as the email address already exists';
            } else if (createaccountop.CreateAccountStatus.FailureReason == "INVALID_EMAIL") {
                reason = 'The account could not be created due to an invalid email address';
            } else if (createaccountop.CreateAccountStatus.FailureReason == "CONCURRENT_ACCOUNT_MODIFICATION") {
                reason = 'The account could not be created due to a conflicting operation';
            } else if (createaccountop.CreateAccountStatus.FailureReason == "INTERNAL_FAILURE") {
                reason = 'The account could not be created due to an internal failure in the Organizations service';
            }

            return {
                "statusCode": 503,
                "isBase64Encoded": false,
                "headers": {
                    "Content-Type": "application/json"
                },
                "body": JSON.stringify({
                    'createAccountSuccess': false,
                    'reason': reason
                })
            };
        }

        accountid = createaccountop.CreateAccountStatus.AccountId;
    }

    let tags = [
        {
            Key: "AccountOwnerGUID",
            Value: user.guid
        },
        {
            Key: "SSOCreationComplete",
            Value: "false"
        }
    ];

    if (process.env.CONTROL_TOWER_MODE == "true") {
        tags.push({
            Key: "ServiceCatalogProvisionedProductId",
            Value: provisionaccountfromproductop.RecordDetail.ProvisionedProductId
        });
    }

    if (notes.length > 0) {
        tags.push({
            Key: "Notes",
            Value: notes
        });
    }
    if (form['shareaccount'] && form['shareaccount'] == "on") {
        tags.push({
            Key: "SharedWithOrg",
            Value: "true"
        });
    }
    if (process.env.ROOT_EMAILS_TO_USER == "true") {
        tags.push({
            Key: "AccountEmailForwardingAddress",
            Value: user.email
        });
    }
    if (maximumspend) {
        tags.push({
            Key: "BudgetThresholdBeforeDeletion",
            Value: maximumspend.toString()
        });
    }

    if (process.env.AUTO_UNSUB_MARKETING == "true") {
        let unsubbody = `FirstName=&LastName=&Email=${encodeURIComponent(accountemail)}&Company=&Phone=&Country=&preferenceCenterCategory=no&preferenceCenterGettingStarted=no&preferenceCenterOnlineInPersonEvents=no&preferenceCenterMonthlyAWSNewsletter=no&preferenceCenterTrainingandBestPracticeContent=no&preferenceCenterProductandServiceAnnoucements=no&preferenceCenterSurveys=no&PreferenceCenter_AWS_Partner_Events_Co__c=no&preferenceCenterOtherAWSCommunications=no&PreferenceCenter_Language_Preference__c=&Title=&Job_Role__c=&Industry=&Level_of_AWS_Usage__c=&LDR_Solution_Area__c=&Unsubscribed=yes&UnsubscribedReason=&unsubscribedReasonOther=&useCaseMultiSelect=&zOPFormValidationBotVerification=&Website_Referral_Code__c=&zOPURLTrackingTRKCampaign=&zOPEmailValidationHygiene=validate&formid=34006&formVid=34006`;

        await rp({ uri: 'https://pages.awscloud.com/index.php/leadCapture/save2', method: 'POST', body: unsubbody}).catch(err => {
            LOG.warn("Failed to unsubscribe from marketing communications");
            LOG.warn(err);
        });
    }

    await retryWrapper(organizations, 'tagResource', {
        ResourceId: accountid,
        Tags: tags
    });

    return {
        "statusCode": 200,
        "isBase64Encoded": false,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": JSON.stringify({
            'createAccountSuccess': true
        })
    };
}

function wrapHTML(user) {
    return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
        <meta name="description" content="">
        <title>${user.ssoprops.SSOManagerAppName}</title>

        <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/css/bootstrap.min.css" integrity="sha384-Vkoo8x4CGsO3+Hhxv8T/Q5PaXtkKtu6ug5TOeNV6gBiFeWPGFN9MuhOf23Q9Ifjh" crossorigin="anonymous">
        <style>
        .fa-trash-alt:hover:before {
            color: #f64f5f !important
        }
        </style>

        <script src="https://kit.fontawesome.com/a9a4873efc.js" crossorigin="anonymous"></script>
      </head>
      <body class="bg-light">
        <div class="container">
        <div class="row">
        <div class="col-md-12">
        <p class="float-right mt-4 text-muted">${user.name} (${user.email})&nbsp;&nbsp;|&nbsp;&nbsp;<a href="${user.ssoprops.SignOutURL}">Back to SSO</a></p>
        </div>
        </div>

        <div id="alerts"></div>
      
        <div class="py-5 text-center" style="padding-top: 1rem!important;">
        <svg class="d-block mx-auto mb-4" height="72" viewBox="0 0 64 64" width="72" xmlns="http://www.w3.org/2000/svg"><g id="AccMgrLogo" data-name="AccMgrLogo"><path d="m53.54 41.34a8.047 8.047 0 0 0 -4.54-4.76v-25.58h-44a2.006 2.006 0 0 0 -2 2v6h40v17.59c-.23.09-.46.2-.68.31a11.984 11.984 0 0 0 -22.15 4.14 10 10 0 0 0 .83 19.96h30a9.993 9.993 0 0 0 2.54-19.66z" fill="#bddbff"/><g fill="#57a4ff"><path d="m6 14h2v2h-2z"/><path d="m10 14h2v2h-2z"/><path d="m14 14h2v2h-2z"/><path d="m38 14h2v2h-2z"/><path d="m12 6h2v2h-2z"/><path d="m16 6h2v2h-2z"/><path d="m20 6h2v2h-2z"/><path d="m44 6h2v2h-2z"/><path d="m54.29 40.51a8.985 8.985 0 0 0 -4.29-4.55v-30.96a3.009 3.009 0 0 0 -3-3h-36a3.009 3.009 0 0 0 -3 3v5h-3a3.009 3.009 0 0 0 -3 3v30a3.009 3.009 0 0 0 3 3h6.23a10.874 10.874 0 0 0 -1.23 5 11.007 11.007 0 0 0 11 11h30a11 11 0 0 0 3.29-21.49zm-44.29-35.51a1 1 0 0 1 1-1h36a1 1 0 0 1 1 1v5h-38zm33.82 7h4.18v23.25a8.454 8.454 0 0 0 -4-.02v-22.23a3 3 0 0 0 -.18-1zm-39.82 1a1 1 0 0 1 1-1h36a1 1 0 0 1 1 1v5h-38zm1 31a1 1 0 0 1 -1-1v-23h38v14.75a12.956 12.956 0 0 0 -22.67 5.38 11.047 11.047 0 0 0 -6.78 3.87zm46 16h-30a9 9 0 0 1 -.74-17.96 1 1 0 0 0 .9-.84 10.982 10.982 0 0 1 20.3-3.79 1 1 0 0 0 1.32.38 6.846 6.846 0 0 1 3.22-.79 7 7 0 0 1 6.59 4.67.993.993 0 0 0 .69.63 9 9 0 0 1 -2.28 17.7z"/><path d="m52.776 44.239-.506 1.936a4.994 4.994 0 0 1 -1.27 9.825v2a6.994 6.994 0 0 0 1.776-13.761z"/><path d="m16 51a5.018 5.018 0 0 1 4.582-4.974l-.163-1.994a7 7 0 0 0 .581 13.968v-2a5.006 5.006 0 0 1 -5-5z"/><path d="m23 56h4v2h-4z"/></g></g></svg>
        <h2>${user.ssoprops.SSOManagerAppName}</h2>
        <p class="lead">Below you can manage the AWS accounts that you have access to.</p>
      </div>
    
      <div class="row">
        <div class="col-md-6 order-md-1 mb-6">
          <h4 class="d-flex justify-content-between align-items-center mb-3">
            <span>Your accounts</span>
            <span id="accounts-count" class="badge badge-secondary badge-pill">-</span>
          </h4>
          <ul id="accounts-list" class="list-group mb-3">
          </ul>
        </div>
        <div class="col-md-1 order-md-2"></div>
        <div class="col-md-5 order-md-3">
          <h4 class="mb-3">Create account</h4>
          <form id="create-account-form" class="needs-validation" novalidate>
            <input id="SAMLResponse" type="hidden" name="SAMLResponse" value="${user.samlresponse}">

            <div class="mb-3">
                <label for="emailprefix">E-mail Prefix</label>
                <div class="input-group">
                    <input type="text" class="form-control" id="emailprefix" name="emailprefix" placeholder="some-identifier" required>
                    <div class="input-group-prepend">
                        <span class="input-group-text">@${process.env.DOMAIN_NAME}</span>
                    </div>
                    <div class="invalid-feedback" style="width: 100%;">
                    An e-mail prefix is required.
                    </div>
                </div>
            </div>
    
            <div class="mb-3">
                <label for="accountname">Account Name</label>
                <input type="text" class="form-control" id="accountname" name="accountname" placeholder="My Account" required>
                <div class="invalid-feedback">
                    An account name is required.
                </div>
            </div>
            ${(process.env.MAXIMUM_ACCOUNT_SPEND == "0") ? '' : `

            <div class="mb-3">
                <label for="accountname">Maximum Monthly Spend (USD)</label>
                <div class="input-group">
                    <div class="input-group-prepend">
                        <span class="input-group-text">$</span>
                    </div>
                    <input type="text" class="form-control" id="maximumspend" name="maximumspend" value="${process.env.MAXIMUM_ACCOUNT_SPEND}" aria-describedby="maximumspendhelp" required>
                    <small id="maximumspendhelp" class="form-text text-muted">
                        Account will be automatically deleted when this threshold is reached.
                    </small>
                    <div class="invalid-feedback" style="width: 100%;">
                    A maximum spend is required.
                    </div>
                </div>
            </div>
            `}
            
            <div class="mb-3">
                <label for="notes">Notes <span class="text-muted">(Optional)</span></label>
                <input type="text" class="form-control" id="notes" name="notes">
            </div>
    
            <hr class="mb-4">

            <div class="custom-control custom-checkbox">
              <input type="checkbox" class="custom-control-input" id="shareaccount" name="shareaccount">
              <label class="custom-control-label" for="shareaccount">This account can be accessed by everyone in my organization</label>
            </div>

            <hr class="mb-4">

            <button id="create-account-submit-button" class="btn btn-primary btn-lg btn-block" type="submit">Create Account</button>
          </form>
        </div>
      </div>

      <div class="modal fade" id="delete-account-modal" tabindex="-1" role="dialog" aria-hidden="true">
        <div class="modal-dialog" role="document">
            <div class="modal-content">
            <div class="modal-body">
                <br />
                <p>Are you sure you want to delete <strong id="delete-account-confirmation-text"></strong>?</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-dismiss="modal">Close</button>
                <button id="delete-account-confirmation-button" data-accountid="" type="button" class="btn btn-danger">Delete Account</button>
            </div>
            </div>
        </div>
      </div>
    
      <footer class="my-5 pt-5 text-muted text-center text-small">
        <p class="mb-1">For support, contact your administrator at <a href="mailto:${process.env.MASTER_EMAIL}">${process.env.MASTER_EMAIL}</a></p>
      </footer>
    </div>
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.0/dist/umd/popper.min.js" integrity="sha384-Q6E9RHvbIyZFJoft+2mJbHaEWldlvI9IOYy5n3zV9zzTtmI3UksdQRVvoxMfooAo" crossorigin="anonymous"></script>
    <script src="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/js/bootstrap.min.js" integrity="sha384-wfSDF2E50Y2D1uUdj0O3uMBJnjuUD4Ih7YwaYd1iqfktj0Uod8GCExl3Og8ifwB6" crossorigin="anonymous"></script>
    <script>
        function refreshAccounts() {
            $.ajax({
                type: 'POST',
                url: '/accounts',
                data: 'SAMLResponse=' + $('#SAMLResponse').val(),
                success: function(response) {
                    $('#accounts-list').html('');
                    $('#accounts-count').html(response.accounts.length);
                    for (const account of response.accounts) {
                        $('#accounts-list').append(\`
                            <li class="list-group-item d-flex justify-content-between lh-condensed">
                            <div>
                                <h6 class="my-0">\${account.Name}\${account.IsShared ? '&nbsp;&nbsp;<span class="badge badge-dark">SHARED</span>' : ''}\${account.IsDeleting ? '&nbsp;&nbsp;<span class="badge badge-warning">DELETING</span>' : ''}\${account.IsCreating ? '&nbsp;&nbsp;<span class="badge badge-success">CREATING</span>' : ''}</h6>
                                <small class="text-muted">Account ID: \${account.Id}</small><br />
                                <small class="text-muted">Account E-mail: \${account.Email}</small><br />
                                <small class="text-muted">Notes: \${account.Notes || ''}</small>
                            </div>
                            <span>\${((account.IsShared && !account.IsOwner) || account.IsDeleting || account.IsCreating) ? '' : \`<i class="fas fa-trash-alt text-danger" data-toggle="modal" data-target="#delete-account-modal" data-accountname="\${account.Name}" data-accountid="\${account.Id}"></i>\`}</span>
                            </li>
                        \`);
                    }
                },
                error: function(response) {
                    if ($('#alerts').html() == "") {
                        $('#alerts').append(\`
                            <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <strong>Account List Failure</strong> The list of accounts could not be loaded for an unknown reason
                            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                                <span aria-hidden="true">&times;</span>
                            </button>
                            </div>
                        \`);

                        window.scrollTo(0, 0);
                    }
                },
            });
        }

        function deleteAccount(accountid) {
            $.ajax({
                type: 'POST',
                url: '/deleteaccount',
                data: 'accountid=' + accountid.trim() + '&SAMLResponse=' + $('#SAMLResponse').val(),
                success: function(response) {
                    $('#alerts').append(\`
                        <div class="alert alert-success alert-dismissible fade show" role="alert">
                        <strong>Account Deletion Requested</strong> Your AWS account deletion request has been successfully processed. This will occur within the next 5 minutes.
                        <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                        </button>
                        </div>
                    \`);

                    $('#delete-account-modal').modal('hide');

                    refreshAccounts();

                    window.scrollTo(0, 0);
                },
                error: function(response) {
                    $('#alerts').append(\`
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                        <strong>Account Creation Failure</strong> The account could not be deleted for an unknown reason
                        <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                        </button>
                        </div>
                    \`);

                    $('#delete-account-modal').modal('hide');

                    window.scrollTo(0, 0);
                },
            });
        }

        $('#create-account-form').submit(e => {
            e.preventDefault();

            $('#create-account-submit-button').attr('disabled', 'disabled');

            $.ajax({
                type: 'POST',
                url: '/createaccount',
                data: $('#create-account-form').serialize(),
                success: function(response) {
                    $('#alerts').append(\`
                        <div class="alert alert-success alert-dismissible fade show" role="alert">
                        <strong>Account Created</strong> Your AWS account has been created successfully. It will be available to use via SSO in a few minutes.
                        <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                        </button>
                        </div>
                    \`);

                    // reset form
                    $('#create-account-form').find('input[type="text"]').val('');
                    $('#create-account-form').find('input[type="checkbox"]').prop('checked', false);
                    $('#create-account-submit-button').removeAttr('disabled');

                    refreshAccounts();

                    window.scrollTo(0, 0);
                },
                error: function(response) {
                    var reason = "The account could not be created for an unknown reason";
                    if (response.responseJSON && response.responseJSON.reason) {
                        reason = response.responseJSON.reason;
                    }

                    $('#alerts').append(\`
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                        <strong>Account Creation Failure</strong> \${reason}
                        <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                        </button>
                        </div>
                    \`);

                    $('#create-account-submit-button').removeAttr('disabled');

                    window.scrollTo(0, 0);
                },
            });
        });

        $(document).ready(function() {
            $('#delete-account-modal').on('show.bs.modal', function (event) {
                var button = $(event.relatedTarget);
                var accountid = button.data('accountid');
                var accountname = button.data('accountname');
                
                $('#delete-account-confirmation-text').html(accountname + " (" + accountid + ")");
                $('#delete-account-confirmation-button').attr('data-accountid', accountid);
                $('#delete-account-confirmation-button').removeAttr('disabled');
            });

            $('#delete-account-confirmation-button').click(function (event) {
                $('#delete-account-confirmation-button').attr('disabled', 'disabled');
                deleteAccount($('#delete-account-confirmation-button').attr('data-accountid'));
            });

            refreshAccounts();
        });

        setInterval(refreshAccounts, 10000);
    </script>
    </body>
    </html>
    `;
}

exports.handler = async (event, context) => {
    let result = null;
    let browser = null;

    LOG.debug(event);

    if (event.source && event.source == "aws.organizations" && event.detail.eventName == "TagResource") {
        isdeletable = false;
        accountowner = null;
        isshared = false;
        budgetthresholdbeforedeletion = null;
        event.detail.requestParameters.tags.forEach(tag => {
            if (tag.key.toLowerCase() == "delete" && tag.value.toLowerCase() == "true") {
                isdeletable = true;
            }
            if (tag.key.toLowerCase() == "accountownerguid") {
                accountowner = tag.value;
            }
            if (tag.key.toLowerCase() == "budgetthresholdbeforedeletion") {
                budgetthresholdbeforedeletion = tag.value;
            }
            if (tag.key.toLowerCase() == "sharedwithorg" && tag.value.toLowerCase() == "true") {
                isshared = true;
            }
        });

        if (isdeletable && process.env.DELETION_FUNCTIONALITY_ENABLED == "true") {
            let data = await retryWrapper(organizations, 'describeAccount', {
                AccountId: event.detail.requestParameters.resourceId
            });

            browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath,
                headless: chromium.headless,
            });
    
            let page = await browser.newPage();
    
            await triggerReset(page, {
                'email': data.Account.Email
            });
        }

        if (accountowner && process.env.CREATION_FUNCTIONALITY_ENABLED == "true") {
            browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath,
                headless: chromium.headless,
            });
    
            let page = await browser.newPage();

            await login(page);

            if (process.env.DENY_SUBSCRIPTION_CALLS) {
                await addSubscriptionsSCP({
                    'accountid': event.detail.requestParameters.resourceId
                });
            }

            if (budgetthresholdbeforedeletion) {
                await addBillingMonitor(page, {
                    'accountid': event.detail.requestParameters.resourceId,
                    'budgetthresholdbeforedeletion': budgetthresholdbeforedeletion
                });
            }
    
            await setSSOOwner(page, {
                'accountowner': accountowner,
                'accountid': event.detail.requestParameters.resourceId,
                'isshared': isshared
            });
        }
    } else if (event.email) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await triggerReset(page, event);
    } else if (event.action == "removeAccountFromOrg") {
        let removed = await removeAccountFromOrg(event.account);

        if (removed) {
            let targetsresponse = await eventbridge.listTargetsByRule({
                Rule: event.ruleName
            }).promise();

            for (const target of targetsresponse.Targets) {
                await eventbridge.removeTargets({
                    Rule: event.ruleName,
                    Ids: [target.Id]
                }).promise();
            }

            await eventbridge.deleteRule({
                Name: event.ruleName
            }).promise();

            LOG.info("Successfully removed rule");
        }
    } else if (event.Records && event.Records[0] && event.Records[0].s3 && event.Records[0].s3.bucket) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await handleEmailInbound(page, event);
    } else if (event.Records && event.Records[0] && event.Records[0].Sns) {
        await processSnsDeleteAccount(event);
    } else if (event.Name && event.Name == "ContactFlowEvent") {
        let connectssmparameter = await ssm.getParameter({
            Name: process.env.CONNECT_SSM_PARAMETER
        }).promise();

        let variables = JSON.parse(connectssmparameter['Parameter']['Value']);

        return {
            "prompt1": variables['PROMPT_' + variables['CODE'][0]],
            "prompt2": variables['PROMPT_' + variables['CODE'][1]],
            "prompt3": variables['PROMPT_' + variables['CODE'][2]],
            "prompt4": variables['PROMPT_' + variables['CODE'][3]]
        }
    } else if (event.ResourceType == "Custom::ConnectSetup") {
        let domain = event.StackId.split("-").pop();

        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        try {
            await login(page);

            if (event.RequestType == "Create") {
                await ses.setActiveReceiptRuleSet({
                    RuleSetName: "account-controller"
                }).promise();

                await createinstance(page, {
                    'Domain': domain
                });
                await page.waitFor(5000);
                await open(page, {
                    'Domain': domain
                });
                let hostx = new url.URL(await page.url()).host;
                while (hostx.indexOf(domain) == -1) {
                    await page.waitFor(20000);
                    await open(page, {
                        'Domain': domain
                    });
                    hostx = new url.URL(await page.url()).host;
                }
                let prompts = await uploadprompts(page, {
                    'Domain': domain
                });
                await createflow(page, {
                    'Domain': domain
                }, prompts);
                let number = await claimnumber(page, {
                    'Domain': domain
                });
                LOG.info("Registered phone number: " + number['PhoneNumber']);
                
                let variables = {};

                ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(num => {
                    variables['PROMPT_' + num] = prompts[num + '.wav'];
                });
                variables['PHONE_NUMBER'] = number['PhoneNumber'].replace(/[ -]/g, "")
    
                await ssm.putParameter({
                    Name: process.env.CONNECT_SSM_PARAMETER,
                    Type: "String",
                    Value: JSON.stringify(variables),
                    Overwrite: true
                }).promise();
            } else if (event.RequestType == "Delete") {
                await ses.setActiveReceiptRuleSet({
                    RuleSetName: "default-rule-set"
                }).promise();

                await ses.deleteReceiptRuleSet({
                    RuleSetName: "account-controller"
                }).promise();

                await deleteinstance(page, {
                    'Domain': domain
                });
            }

            await sendcfnresponse(event, context, "SUCCESS", {
                'Domain': domain
            }, domain);
        } catch(error) {
            await sendcfnresponse(event, context, "FAILED", {});

            await debugScreenshot(page);

            throw error;
        }
    } else if (event.ResourceType == "Custom::SSOSetup") {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        try {
            await login(page);

            if (event.RequestType == "Create") {
                await createssoapp(page, {
                    'SSOManagerAppName': event.ResourceProperties.SSOManagerAppName,
                    'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
                });
            } else if (event.RequestType == "Delete") {
                await deletessoapp(page, {
                    'SSOManagerAppName': event.ResourceProperties.SSOManagerAppName,
                    'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
                });
            }

            await sendcfnresponse(event, context, "SUCCESS", {
                "SSOManagerAppName": event.ResourceProperties.SSOManagerAppName,
                'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
            }, "SSOManager");
        } catch(error) {
            await sendcfnresponse(event, context, "FAILED", {});

            await debugScreenshot(page);

            throw error;
        }
    } else if (event.routeKey == "GET /") {
        let ssoparamresponse = await ssm.getParameter({
            Name: process.env.SSO_SSM_PARAMETER
        }).promise();
        let ssoproperties = JSON.parse(ssoparamresponse['Parameter']['Value']);
        
        return {
            "statusCode": 302,
            "headers": {
                "Location": ssoproperties['SignOutURL']
            }
        };
    } else if (event.routeKey == "POST /") {
        try {
            let resp = await handleSAMLResponse(event);

            return resp;
        } catch(err) {
            LOG.error(err);
        }

        return {
            "statusCode": 500,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "index/html"
            },
            "body": ""
        };
    } else if (event.routeKey == "POST /accounts") {
        try {
            let resp = await handleGetAccounts(event);
            return resp;
        } catch(err) {
            LOG.error(err);
        }

        return {
            "statusCode": 500,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": ""
        };
    } else if (event.routeKey == "POST /createaccount") {
        try {
            let resp = await handleCreateAccountRequest(event);
            return resp;
        } catch(err) {
            LOG.error(err);
        }

        return {
            "statusCode": 500,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": ""
        };
    } else if (event.routeKey == "POST /deleteaccount") {
        try {
            let resp = await handleDeleteAccountRequest(event);
            return resp;
        } catch(err) {
            LOG.error(err);
        }
        
        return {
            "statusCode": 500,
            "isBase64Encoded": false,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": ""
        };
    } else {
        return context.succeed();
    }
};

