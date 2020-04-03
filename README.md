# AWS Account Controller

> Manage the creation and deletion of sandbox-style accounts.

> :exclamation: **PLEASE READ [THE CAVEATS](https://onecloudplease.com/blog/automating-aws-account-deletion) OF THIS SOLUTION BEFORE CONTINUING**

> :construction: The current state of the stack has little to no resilience against errors such as CAPTCHA failures - this notice will be removed as this reaches an acceptable level

## Prerequisites

The following is required before proceeding:

* A registered domain name or subdomain, which is publicly accessible
* A credit card which will be used to apply payment information to terminated accounts
* A [2captcha](https://2captcha.com/) account that is sufficiently topped-up with credit
* A preferred master e-mail address to receive account correspondence to

## Installation

[![Launch Stack](https://cdn.rawgit.com/buildkite/cloudformation-launch-stack-button-svg/master/launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=account-controller&templateURL=https://s3.amazonaws.com/ianmckay-us-east-1/accountcontroller/template.yml)

Click the above link to deploy the stack to your environment. This stack creates:

* Optionally, a Route 53 hosted zone (or provide your own by zone ID)
* An MX record to SES inbound in the hosted zone
* An event rule that triggers Lambda execution when an organizations account is tagged
* Node.js Lambda Function, used for all actions performed, with appropriate permissions
* Log group for the Lambda Function, with a short term expiry
* An S3 bucket for debugging screenshots, with a short term expiry
* An S3 bucket for storing raw e-mail content, with a short term expiry
* An SES Receipt Rule Set, which is automatically promoted to be default
* An IAM user with a login profile, used to deploy a Connect instance

If you prefer, you can also manually upsert the [template.yml](https://github.com/iann0036/aws-account-controller/blob/master/template.yml) stack from source.

If you chose to have the stack create a hosted zone for the account root e-mails instead of you bringing your own, you should ensure the nameservers of the new zone are associated with an accessible domains (automatic if the domain was created within Route 53).

Currently, the only tested region is `us-east-1`. The stack deploy time is approximately 7 minutes.

#### Uninstallation

To remove this solution, ensure that both S3 buckets have their objects removed then delete the CloudFormation stack. The SES Receipt Rule Set will revert back to `default-rule-set`.

## Usage

In order to elect to delete an account, simply tag an account within the Organizations console with the following:

*Tag Key:* **delete**

*Tag Value:* **true**

Once tagged, a process will perform the following actions on your behalf:

* Trigger a password reset for the root account
* Reset the password to the automatically generated master password
* Add payment information to the account
* Perform a phone verification of the account
* Close the account
* Remove the account from Organizations

The above process takes approximately 3 minutes.

Note that an account is required to have existed for 7 days or more to be successfully removed from Organizations.
