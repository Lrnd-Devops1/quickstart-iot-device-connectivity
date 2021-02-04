import * as cdk from '@aws-cdk/core';
import { RemovalPolicy, Duration, CfnOutput, CfnParameter, Fn } from '@aws-cdk/core';
import * as iot from '@aws-cdk/aws-iot';
import * as iam from '@aws-cdk/aws-iam';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import { Bucket } from "@aws-cdk/aws-s3";
import lambda = require('@aws-cdk/aws-lambda');
import apiGateway2 = require('@aws-cdk/aws-apigatewayv2');
import apiGatewayIntegrations = require('@aws-cdk/aws-apigatewayv2-integrations')
import { HttpRoute, CfnRoute, CfnAuthorizer } from "@aws-cdk/aws-apigatewayv2";
import cognito = require('@aws-cdk/aws-cognito');
import kinesisfirehose = require('@aws-cdk/aws-kinesisfirehose');
import glue = require('@aws-cdk/aws-glue');
import { UserPool } from "@aws-cdk/aws-cognito";


var DEVICE_ROOT_TOPIC_DEFAULT = "data/#"
var TEST_TOPIC = "alldata_test"

export class IOTOnboardingInfraStack extends cdk.Stack {

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envName = this.node.tryGetContext("envName");
    const artifactBucketName = this.node.tryGetContext("artifactBucket");
    const region = (props && props.env) ? props.env.region : ""
    const account = (props && props.env) ? props.env.account : ""
    if (!envName) {
      throw new Error('No environemnt name provided for stack');
    }
    if (!artifactBucketName) {
      throw new Error('No artifact bucket provided name provided for stack');
    }

    //Cloudformation parammetters
    const devicesRootTopic = new CfnParameter(this, "devicesRootTopic", {
      type: "String",
      default: DEVICE_ROOT_TOPIC_DEFAULT,
      description: "the root MQTT topic where onboarded devices publish"
    });

    //////////////////////////////////////////////////////////////////
    // O. Creating Analytic Pipeline
    /////////////////////////////////////////////////////////////////
    //data role 
    const firehoseRole = new iam.Role(this, "iot-onboarding-data-firehose-role-" + envName, {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      description: "firehose role for ingesting raw sensors data ",
      roleName: "iot-onboarding-sensors-data-firehose-role-" + envName
    })
    const glueRole = new iam.Role(this, "iot-onboarding-data-glue-role-" + envName, {
      assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
      description: "Glue role for crawling raw data bucket on sensors data ",
      roleName: "iot-onboarding-sensors-data-glue-role-" + envName
    })
    //granting general logging
    glueRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"))
    glueRole.addToPolicy(new iam.PolicyStatement({
      resources: ["arn:aws:logs:" + this.region + ":" + this.account + ":log-group:/*"],
      actions: ["logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"]
    }))
    //we need to gran the datalake admin (which will be the rol for all glue jobs) access to the artifact bucket
    //since the python scripts are stored there
    const artifactsBucket = Bucket.fromBucketName(this, 'rigadoSensorsArtifactBucket', artifactBucketName);
    artifactsBucket.grantReadWrite(glueRole)

    //Glue database
    const glueDb = new glue.Database(this, "iot-onboarding-data-glue-database-" + envName, {
      databaseName: "iot-onboarding-sensors-data-" + envName
    })
    new CfnOutput(this, "glueDbName", { value: glueDb.databaseName })

    //S3 Bucket for sensor data
    const sensorsDataBucket = new Bucket(this, "iotOnboardingSensorsDeviceBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })
    //Temp bucket for relationizing
    const sensorsDataBucketTemp = new Bucket(this, "iotOnboardingSensorsDataBucketTemp", {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })
    const sensorsDataBucketRefined = new Bucket(this, "iotOnboardingSensorsDataBucketRefined", {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })
    sensorsDataBucket.grantReadWrite(firehoseRole)
    sensorsDataBucket.grantReadWrite(glueRole)
    sensorsDataBucketRefined.grantReadWrite(glueRole)
    sensorsDataBucketTemp.grantReadWrite(glueRole)

    //Delivery Stream
    let firehoseDeliveryStream = new kinesisfirehose.CfnDeliveryStream(this, "iotOnboardingSensorsDataDeliveryStream", {
      deliveryStreamName: "iotOnboardingSensorsDataDeliveryStream" + envName,
      deliveryStreamType: "DirectPut",
      s3DestinationConfiguration: {
        bucketArn: sensorsDataBucket.bucketArn,
        roleArn: firehoseRole.roleArn
      }
    })

    const glueCrawler = new glue.CfnCrawler(this, "iot-onboarding-sensor-data-crawler", {
      role: glueRole.roleArn,
      targets: {
        s3Targets: [{ path: "s3://" + sensorsDataBucket.bucketName }]
      },
      configuration: `{
        "Version": 1.0,
        "Grouping": {
           "TableGroupingPolicy": "CombineCompatibleSchemas" }
     }`,
      databaseName: glueDb.databaseName,
      name: "iot-onboarding-sensor-data-crawler-" + envName
    })

    const glueCrawlerRefined = new glue.CfnCrawler(this, "iot-onboarding-sensor-data-crawler-refined", {
      role: glueRole.roleArn,
      targets: {
        s3Targets: [{ path: "s3://" + sensorsDataBucketRefined.bucketName }]
      },
      configuration: `{
        "Version": 1.0,
        "Grouping": {
           "TableGroupingPolicy": "CombineCompatibleSchemas" }
     }`,
      databaseName: glueDb.databaseName,
      name: "iot-onboarding-sensor-data-crawler-refined-" + envName
    })
    //We need to use Fn.split as bucketName is a BucketName which extends Token
    const sensorDataAthenaTableName = Fn.join("_", Fn.split('-', sensorsDataBucket.bucketName))
    const sensorRefinedDataAthenaTableName = Fn.join("_", Fn.split('-', sensorsDataBucketRefined.bucketName))
    new CfnOutput(this, "athenaTableName", { value: sensorRefinedDataAthenaTableName })

    //Glue job to flatten the data
    const dataFlatteingJob = new glue.CfnJob(this, "iot-onboarding-sensor-flattening-job-" + envName, {
      command: {
        name: "glueetl",
        scriptLocation: "s3://" + artifactBucketName + "/" + envName + "/etl/iotOnboardingSensorFlatteningJob.py"
      },
      glueVersion: "2.0",
      defaultArguments: {
        '--enable-continuous-cloudwatch-log': 'true',
        "--job-bookmark-option": "job-bookmark-enable",
        "--enable-metrics": "true",
        "--GLUE_DB": glueDb.databaseName,
        "--SOURCE_TABLE": sensorDataAthenaTableName,
        "--TEMP_BUCKET": sensorsDataBucketTemp.bucketName,
        "--DEST_BUCKET": sensorsDataBucketRefined.bucketName,
      },
      executionProperty: {
        maxConcurrentRuns: 1
      },
      timeout: 60,
      maxRetries: 0,
      name: "iotOnboardingSensorFlatteningJob" + envName,
      role: glueRole.roleArn
    })

    //partitionnning done by firehose is down to the hour so we just need to crawl 2 minutes after the top of the hour
    const workflowTrigger = new glue.CfnTrigger(this, "iot-onboarding-sensor-workflow-trigger-" + envName, {
      type: "SCHEDULED",
      name: "iotOnboardingSensorWorkflowTrigger" + envName,
      schedule: "cron(0 * ? * * *)",
      startOnCreation: true,
      actions: [
        { crawlerName: glueCrawler.name }
      ]
    })

    //we trigger the job every 2 minutes as Firehose ingestion buffer min is 1 minute (60 sec)
    //bookmarking should keep the job under 2 minute
    const jobTrigger = new glue.CfnTrigger(this, "iot-onboarding-sensor-flattening-job-trigger-" + envName, {
      type: "SCHEDULED",
      name: "iotOnboardingSensorFlatteningJobTrigger" + envName,
      schedule: "cron(5 * ? * * *)",
      startOnCreation: true,
      actions: [
        { jobName: dataFlatteingJob.name }
      ]
    })

    const refinedCrawlerTrigger = new glue.CfnTrigger(this, "iot-onboarding-sensor-refined-trigger-" + envName, {
      type: "CONDITIONAL",
      name: "iotOnboardingSensorRefinedTrigger-" + envName,
      startOnCreation: true,
      predicate: {
        conditions: [
          {
            jobName: dataFlatteingJob.name,
            state: "SUCCEEDED",
            logicalOperator: "EQUALS"
          }
        ]
      },
      actions: [
        { crawlerName: glueCrawlerRefined.name }
      ]
    })


    ///////////////////////////////////////
    // I.Creating DynamoDB Tables
    ///////////////////////////////////////

    //I.a DynamoDB Table to store events from the IOT Events Detector
    /////////////////////////////////////////////////////////////////
    const dynamo_pk = "deviceId"
    const dynamo_sk = "timestamp"
    const iotonboardingTable = new dynamodb.Table(this, id + 'iotonboardingSensorTable', {
      tableName: "iot-onboarding-sensors-" + envName,
      partitionKey: { name: dynamo_pk, type: dynamodb.AttributeType.STRING },
      sortKey: { name: dynamo_sk, type: dynamodb.AttributeType.NUMBER },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //I.b DynamoDB Table to stor Device onboarding data (Serial number)
    /////////////////////////////////////////////////////////////////
    const dynamo_onboarding_pk = "deviceGroup"
    const dynamo_onboarding_sk = "serialNumber"
    const onboardingTable = new dynamodb.Table(this, id + 'iotonboardingOnbordingTable', {
      tableName: "iot-onboarding-onboarding-" + envName,
      partitionKey: { name: dynamo_onboarding_pk, type: dynamodb.AttributeType.STRING },
      sortKey: { name: dynamo_onboarding_sk, type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //////////////////////////////////////////////////////////////////
    // II. Creating On Boarding Service
    /////////////////////////////////////////////////////////////////

    //II.a Creating Cognito User pool for on boarding service security
    /////////////////////////////////////////////////////////////////

    const userPool: UserPool = new cognito.UserPool(this, id + "iotonboardingOnboardingUserPool", {
      signInAliases: { email: true },
      userPoolName: "iotonboardingOnboardingUserpool" + envName
    });

    const cognitoAppClient = new cognito.CfnUserPoolClient(this, id + "iotonboardingOnboardingUserPoolClient", {
      userPoolId: userPool.userPoolId,
      allowedOAuthFlows: ["implicit", "code"],
      allowedOAuthFlowsUserPoolClient: true,
      supportedIdentityProviders: ["COGNITO"],
      explicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      generateSecret: false,
      refreshTokenValidity: 2650,
      allowedOAuthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
      clientName: "iotonboardingOnboardingWizard",
      callbackUrLs: ["http://localhost:4200"],
      logoutUrLs: ["http://localhost:4200"]
    })

    const domain = new cognito.CfnUserPoolDomain(this, id + "CognitoDomain", {
      userPoolId: userPool.userPoolId,
      domain: "iot-onboarding-quickstart-" + envName
    })

    //Generating outputs used to obtain refresh token
    new CfnOutput(this, "userPoolId", { value: userPool.userPoolId })
    new CfnOutput(this, "cognitoAppClientId", { value: cognitoAppClient.ref })
    new CfnOutput(this, "tokenEnpoint", { value: "https://" + domain.domain + ".auth." + region + ".amazoncognito.com/oauth2/token" })


    //II.b Amazon S3 Buckets to store Lambda function code and certificates
    //////////////////////////////////////////////////////////////////////////
    const certificateBucket = new Bucket(this, "iotonboardingCertificate-" + envName, {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })

    // II.c Lambda function supporting on boarding services
    /////////////////////////////////////////////////////////////////////////
    const prefix = 'iotOnBoarding'
    const lamdbaCodeBucket = Bucket.fromBucketName(this, 'BucketByName', artifactBucketName);
    const onboardingLambda = new lambda.Function(this, prefix + 'Lambda' + envName, {
      code: new lambda.S3Code(lamdbaCodeBucket, [envName, prefix, 'main.zip'].join("/")),
      functionName: prefix + envName,
      handler: 'main',
      runtime: lambda.Runtime.GO_1_X,
      tracing: lambda.Tracing.ACTIVE,
      timeout: Duration.seconds(60),
      environment: {
        LAMBDA_ENV: envName,
        S3_MULTIMEDIA: certificateBucket.bucketName,
        ONBOARDING_TABLE_NAME: onboardingTable.tableName,
        ONBOARDING_TABLE_PK: dynamo_onboarding_pk,
        ONBOARDING_TABLE_SK: dynamo_onboarding_sk,
        "MAIN_TOPIC": devicesRootTopic.valueAsString,
      }
    });
    certificateBucket.grantReadWrite(onboardingLambda)
    onboardingTable.grantFullAccess(onboardingLambda)
    onboardingLambda.addToRolePolicy(new iam.PolicyStatement({
      resources: ["*"],
      actions: ['iot:CreateKeysAndCertificate',
        'iot:CreatePolicy',
        "iot:CreateThing",
        "iot:DeleteCertificate",
        "iot:DeletePolicy",
        "iot:DeleteThing",
        "iot:DescribeThing",
        "iot:DescribeEndpoint",
        "iot:DetachThingPrincipal",
        "iot:ListThings",
        "iot:AttachThingPrincipal",
        "iot:AttachPolicy",
        "iot:DetachPolicy",
        "iot:UpdateCertificate"]
    }));
    //II.d API Gateway Enpoint for on boarding service
    /////////////////////////////////////////////////////////////////////////
    let apiV2 = new apiGateway2.HttpApi(this, "rogadoOnboarding" + envName, {
      apiName: "iotonboardingOnboarding" + envName,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apiGateway2.HttpMethod.OPTIONS, apiGateway2.HttpMethod.GET, apiGateway2.HttpMethod.POST, apiGateway2.HttpMethod.PUT, apiGateway2.HttpMethod.DELETE],
        allowHeaders: ["*"]
      }
    })

    const cfnAuthorizer = new CfnAuthorizer(this, id + "iotonboardingOnboardingAuthorizer", {
      name: "iotonboardingOnboardingAuthorizer",
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      apiId: apiV2.httpApiId,
      jwtConfiguration: {
        audience: [cognitoAppClient.ref],
        issuer: "https://cognito-idp." + region + ".amazonaws.com/" + userPool.userPoolId
      }
    });

    //Enpoint and Stage name
    const endpointName = "onboard"
    const stageName = "api"

    //creating all routes with lambda proxy integration
    let allRoutes: Array<HttpRoute>;
    //session endpoint used for ping + quick 401 to redirect to login + refressing static session info
    allRoutes = apiV2.addRoutes({
      path: '/' + endpointName + "/{id}",
      methods: [apiGateway2.HttpMethod.POST, apiGateway2.HttpMethod.GET, apiGateway2.HttpMethod.PUT, apiGateway2.HttpMethod.DELETE],
      integration: new apiGatewayIntegrations.LambdaProxyIntegration({
        handler: onboardingLambda,
        payloadFormatVersion: apiGateway2.PayloadFormatVersion.VERSION_1_0,
      })
    });
    //Adding authorizer To all routes
    allRoutes.forEach(route => {
      let cfnRoute = <CfnRoute>route.node.defaultChild;
      cfnRoute.authorizationType = "JWT"
      cfnRoute.authorizerId = cfnAuthorizer.ref
    })

    //creating stage
    let apiV2Stage = new apiGateway2.HttpStage(this, "iotonboardingOnboardingApiStage", {
      httpApi: apiV2,
      stageName: stageName,
      autoDeploy: true
    })
    //Generating output to be returned to user
    new CfnOutput(this, 'iotOnboardingApiUrl', { value: apiV2.url || "" });

    //Adding rights for API Gateway to call lambda function
    onboardingLambda.addPermission("invokePermissionPartner", {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: "lambda:InvokeFunction",
      sourceArn: "arn:aws:execute-api:" + region + ":" + account + ":" + apiV2.httpApiId + "/*/*/" + endpointName
    })
    onboardingLambda.addPermission("invokePermissionPartnerWithId", {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: "lambda:InvokeFunction",
      sourceArn: "arn:aws:execute-api:" + region + ":" + account + ":" + apiV2.httpApiId + "/*/*/" + endpointName + "/*"
    })

    //////////////////////////////////////////////////////////////////
    // III. Creating Rules
    /////////////////////////////////////////////////////////////////

    /*********************************************************************
    * upon message reception, from the selected device (DEVICE_TYPE)
    * Action: Send message to IOT Event and IOT Sitewise
    ************************************************************************/

    const iotServiceRole = new iam.Role(this, 'iotonboardingSensorMqttBrokerRole' + envName, {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
    });
    iotServiceRole.addToPolicy(new iam.PolicyStatement({
      resources: ["arn:aws:iot:" + region + ":" + account + ":topic/" + TEST_TOPIC],
      actions: ['iot:Publish'],
    }));
    //Policy allowing to put data to Firehose
    iotServiceRole.addToPolicy(new iam.PolicyStatement({
      resources: [firehoseDeliveryStream.attrArn],
      actions: ['firehose:PutRecord', "firehose:PutRecordBatch"],
    }));
    //Policy allowing to put data to IOT sitewise
    iotServiceRole.addToPolicy(new iam.PolicyStatement({
      resources: ["*"],
      actions: ['iotsitewise:BatchPutAssetPropertyValue'],
    }));
    new iot.CfnTopicRule(this, "iotonboardingIotRule" + envName, {
      ruleName: "iotonboardingToIotFirehoseAndSitewise" + envName,
      topicRulePayload: {
        actions: [
          {
            iotSiteWise: {
              roleArn: iotServiceRole.roleArn,
              putAssetPropertyValueEntries: [{
                propertyValues: [{
                  timestamp: {
                    timeInSeconds: "${floor(timestamp() / 1E3)}"
                  },
                  value: {
                    booleanValue: "${cast(measurements.occupied as Bool)}"
                  },
                  quality: "GOOD"
                }],
                propertyAlias: "${device.deviceId}Occupancy",
              },
              {
                propertyValues: [{
                  timestamp: {
                    timeInSeconds: "${floor(timestamp() / 1E3)}"
                  },
                  value: {
                    doubleValue: "${cast(measurements.temperature as Double)}"
                  },
                  quality: "GOOD"
                }],
                propertyAlias: "${device.deviceId}Temperature",
              },
              {
                propertyValues: [{
                  timestamp: {
                    timeInSeconds: "${floor(timestamp() / 1E3)}"
                  },
                  value: {
                    doubleValue: "${cast(measurements.humidity as Double)}"
                  },
                  quality: "GOOD"
                }],
                propertyAlias: "${device.deviceId}Humidity",
              }]
            }
          },
          {
            firehose: {
              roleArn: iotServiceRole.roleArn,
              deliveryStreamName: firehoseDeliveryStream.deliveryStreamName || "",
              separator: "\n"
            }
          },
          {
            republish: {
              roleArn: iotServiceRole.roleArn,
              topic: TEST_TOPIC
            }
          }],
        ruleDisabled: false,
        //version is required here due to the cast syntax (fails with latest version) 
        awsIotSqlVersion: "2016-03-23",
        sql: "SELECT *,timestamp() as ts FROM '" + devicesRootTopic.valueAsString + "'"
      }
    })


    /******************************
     * IOT Sitewise foundations
     **************************/
    //IOT sitewise is not yet supported by CDK but deploying sitewise dashboard using CLI require some resources 
    // that are supported (e.g IAM roles)

    const iotSitewiseServiceRole = new iam.Role(this, 'iotOnboardingIotSitewiseRole' + envName, {
      assumedBy: new iam.ServicePrincipal('monitor.iotsitewise.amazonaws.com'),
    });

    iotSitewiseServiceRole.addToPolicy(new iam.PolicyStatement({
      resources: ["*"],
      actions: [
        "iotsitewise:CreateProject",
        "iotsitewise:DescribeProject",
        "iotsitewise:UpdateProject",
        "iotsitewise:DeleteProject",
        "iotsitewise:ListProjects",
        "iotsitewise:BatchAssociateProjectAssets",
        "iotsitewise:BatchDisassociateProjectAssets",
        "iotsitewise:ListProjectAssets",
        "iotsitewise:CreateDashboard",
        "iotsitewise:DescribeDashboard",
        "iotsitewise:UpdateDashboard",
        "iotsitewise:DeleteDashboard",
        "iotsitewise:ListDashboards",
        "iotsitewise:CreateAccessPolicy",
        "iotsitewise:DescribeAccessPolicy",
        "iotsitewise:UpdateAccessPolicy",
        "iotsitewise:DeleteAccessPolicy",
        "iotsitewise:ListAccessPolicies",
        "iotsitewise:DescribeAsset",
        "iotsitewise:ListAssets",
        "iotsitewise:ListAssociatedAssets",
        "iotsitewise:DescribeAssetProperty",
        "iotsitewise:GetAssetPropertyValue",
        "iotsitewise:GetAssetPropertyValueHistory",
        "iotsitewise:GetAssetPropertyAggregates",
        "iotsitewise:BatchPutAssetPropertyValue",
        "iotsitewise:ListAssetRelationships",
        "sso-directory:DescribeUsers",
        "iotevents:DescribeAlarmModel",
        "iotevents:BatchPutMessage",
        "iotevents:BatchAcknowledgeAlarm",
        "iotevents:BatchSnoozeAlarm"
      ]
    })
    );

    new CfnOutput(this, "iotSitewiseServiceRole", { value: iotSitewiseServiceRole.roleArn })

  }
}
