#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { IOTOnboardingInfraStack } from '../lib/iot-onboarding-infra-stack';
import { Tag } from "@aws-cdk/core";

const app = new cdk.App();
const envName = app.node.tryGetContext("envName");

let stack = new IOTOnboardingInfraStack(app, 'IOTOnboardingInfraStack' + envName, {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,

    },
    description: "Deploys the IoT Device connectivity infrastructure (qs-1rmbfu8ed)",
});
stack.templateOptions.metadata = { "QuickStartDocumentation": { EntrypointName: "Parameters for launching the deployment pipeline" } }


/**************
 * Tagging all resources in stack
 */
cdk.Tags.of(stack).add('application-name', 'iot-onboarding');
cdk.Tags.of(stack).add('application-env', envName);

app.synth();
