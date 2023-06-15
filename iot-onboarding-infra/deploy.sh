
# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: MIT-0
env=$1
bucket=$2
mqttTopic=$3
email=$4

echo "***********************************************"
echo "* IOT Onboarding: Infrastructure in environement '$env' and artifact bucket '$bucket'"
echo "************************************************"
if [ -z "$env" ] || [ -z "$bucket" ]
then
    echo "Environment Must not be Empty"
    echo "Usage:"
    echo "sh deploy.sh <env> <bucket> <contactEmail>"
else
    echo "Checking pre-requiresits'$env' "
    OUTRegion=$(aws configure get region)
    echo "checking if a version of teh lambda package exists in the artifact bucket and uploading a default version if not"
    aws s3 cp s3://$bucket/$env/iotOnBoarding/main.zip main.zip 
    if [ $? -ne 0 ]; then
        aws s3 cp main.zip s3://$bucket/$env/iotOnBoarding/main.zip
    fi

    if [ -z "$OUTRegion" ]; then
        echo "The AWS CLI on this envitonement is not configured with a region."
        echo "Usage:"
        echo "aws configure set region <region-name> (ex: us-west-1)"
        exit 1
    fi
    echo "DEPLOYEMENT ACTIONS'$env' "
    echo "***********************************************"
    echo "1.0-Building stack for environement '$env' "
    npm run build

    echo "1.1-Synthesizing CloudFormation template for environement '$env' "
    cdk --app bin/iot-onboarding-infra.js synth -c envName=$env -c artifactBucket=$bucket -c mqttTopic=$mqttTopic > iot-onboarding-infra.yml
    echo "1.2-Analyzing changes for environment '$env' "
    cdk --app bin/iot-onboarding-infra.js diff -c envName=$env -c artifactBucket=$bucket
    echo "1.3-Deploying infrastructure for environement '$env' "
    cdk --app bin/iot-onboarding-infra.js deploy IOTOnboardingInfraStack$env -c envName=$env -c artifactBucket=$bucket -c mqttTopic=$mqttTopic --require-approval never
    rc=$?
    if [ $rc -ne 0 ]; then
      echo "CDK Deploy Failed! Existing Build with status $rc" >&2
      exit $rc
    fi


    echo "Post-Deployment Actions for env '$env' "
    echo "***********************************************"
    echo ""
    echo "Generating Configuration'$env' "
    echo "3.0-Removing existing config filr for '$env' (if exists)"
    rm iot-onboarding-infra-config-$env.json
    echo "3.1-Generating new config file for env '$env'"
    apiEndpoint=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='iotOnboardingApiUrl'].OutputValue" --output text)
    userPoolId=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='userPoolId'].OutputValue" --output text)
    clientId=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='cognitoAppClientId'].OutputValue" --output text)
    tokenEnpoint=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='tokenEnpoint'].OutputValue" --output text)
    glueDbName=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='glueDbName'].OutputValue" --output text)
    athenaTableName=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='athenaTableName'].OutputValue" --output text)
    iotSitewiseRole=$(aws cloudformation describe-stacks --stack-name IOTOnboardingInfraStack$env --query "Stacks[0].Outputs[?OutputKey=='iotSitewiseServiceRole'].OutputValue" --output text)

    echo "3.2 CReating admin User and getting rfresh token"
    RANDOM=$$
    time=$(date +"%Y-%m-%d-%H-%M-%S")
    username="iot-onboarding-admin-$time@example.com"
    password="testPassword1\$$RANDOM"
    echo "{\"username\" : \"$username\"}" > userInfo.json
    echo "1. Create user $username for testing"
    aws cognito-idp admin-create-user --user-pool-id $userPoolId --username $username --message-action "SUPPRESS"
    aws cognito-idp admin-set-user-password --user-pool-id $userPoolId --username $username --password $password --permanent 
    aws cognito-idp admin-initiate-auth --user-pool-id $userPoolId\
                                        --client-id $clientId\
                                        --auth-flow ADMIN_USER_PASSWORD_AUTH\
                                        --auth-parameters USERNAME=$username,PASSWORD=$password> loginInfo.json
    cat loginInfo.json
    refershToken=$(jq -r .AuthenticationResult.RefreshToken loginInfo.json)
    rm loginInfo.json

    summary='
    <h3>AWS IOT Connectivity QuickStart Output Values</h3></br>
    --------------------------------------------------------------------------------------------</br>
    | Cognito URL             |  '$tokenEnpoint'</br>
    --------------------------------------------------------------------------------------------</br>
    | API Gateway URL         |  '$apiEndpoint'</br>
    --------------------------------------------------------------------------------------------</br>
    | Client ID               |  '$clientId'</br>
    --------------------------------------------------------------------------------------------</br>
    | Refresh Token           |  '$refershToken'</br>
    --------------------------------------------------------------------------------------------</br>
    | Environment             |  '$env'</br>
    --------------------------------------------------------------------------------------------</br>
    | Region                  |  '$OUTRegion'</br>
    --------------------------------------------------------------------------------------------</br>
    | Cognito User Pool ID    |  '$userPoolId'</br>
    --------------------------------------------------------------------------------------------</br>
    | Password                |  '$password'</br>
    --------------------------------------------------------------------------------------------</br>
    | Glue DB Name            |  '$glueDbName'</br>
    -------------------------------------------------------------------------------------------- </br>
    | Athena Table Name       |  '$athenaTableName'</br>
    --------------------------------------------------------------------------------------------</br>
    | Iot Sitewise Role       |  '$iotSitewiseRole'</br>
    --------------------------------------------------------------------------------------------</br>'
    echo "$summary"
    
    echo "Sending stack outputs to email: $email"
    aws ses send-email --from "$email" --destination "ToAddresses=$email" --message "Subject={Data=Your IOT Connectiviity Quickstart deployment Output,Charset=utf8},Body={Text={Data=$summary,Charset=utf8},Html={Data=$summary,Charset=utf8}}"
 
 echo "{"\
         "\"env\" : \"$env\","\
         "\"onboardingApiEndpoint\" : \"$apiEndpoint\","\
         "\"cognitoUserPoolId\" : \"$userPoolId\","\
         "\"cognitoClientId\" : \"$clientId\","\
         "\"cognitoRefreshToken\" : \"$refershToken\","\
         "\"password\" : \"$password\","\
         "\"tokenEnpoint\" : \"$tokenEnpoint\","\
        "\"iotSitewiseRole\" : \"$iotSitewiseRole\","\
        "\"glueDbName\" : \"$glueDbName\","\
         "\"athenaTableName\" : \"$athenaTableName\","\
         "\"region\":\"$OUTRegion\""\
         "}">infra-config-$env.json
    cat infra-config-$env.json
aws s3 cp infra-config-$env.json s3://$bucket

fi
