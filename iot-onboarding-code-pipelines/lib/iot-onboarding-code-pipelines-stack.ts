import cdk = require('@aws-cdk/core');
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');
import { CfnParameter, StackProps, RemovalPolicy, ScopedAws, SecretValue } from "@aws-cdk/core";
import { Bucket, BucketEncryption } from "@aws-cdk/aws-s3";
import { Role, ServicePrincipal, ManagedPolicy } from "@aws-cdk/aws-iam";
import kms = require('@aws-cdk/aws-kms');


export class IotOnboardingCodePipelinesStack extends cdk.Stack {

  constructor(scope: cdk.Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const {
      region,
    } = new ScopedAws(this)

    //const gitHubRepo = "aws-quickstart/quickstart-iot-device-connectivity"
    const gitHubRepo = "quickstart-iot-device-connectivity"

    //CloudFormatiion Input Parmetters to be provided by end user:
    const contactEmail = new CfnParameter(this, "contactEmail", {
      type: "String",
      allowedPattern: "^([a-zA-Z0-9_\\-\\.]+)@([a-zA-Z0-9_\\-\\.]+)\\.([a-zA-Z]{2,5})$",
      description: "Email address for the administrator. This is also used for the IoT Sitewise portal creation."
    });
    const quickSightAdminUserName = new CfnParameter(this, "quickSightAdminUserName", {
      type: "String",
      description: "(Optional) Username of an Amazon QuickSight user with an Admin role. If left blank, the QuickSight dashboard will not be included"
    });
    const quickSightAdminUserRegion = new CfnParameter(this, "quickSightAdminUserRegion", {
      type: "String",
      description: "The region of the above QuickSight user. E.g.: us-east-1"
    });
    const sourceTemplateArn = new CfnParameter(this, "sourceTemplateArn", {
      type: "String",
      description: "(Optional) ARN of a public QuickSight dashboard. If using Rigado Alegro kit use arn:aws:quicksight:eu-central-1:660526416360:template/iotOnboardingRigadoQuicksightPublicTemplatedev for an example dashboard."
    });
    const rootMqttTopic = new CfnParameter(this, "rootMqttTopic", {
      type: "String",
      allowedPattern: ".+",
      default: "data/#",
      description: "The root MQTT topic to which devices publish data. Leave the default (data/#) if using the Rigado Alegro kit. If using your own devices, you can create your own dataset, analysis and dashboard based on your devices."
    });
    const envNameVal = new CfnParameter(this, "environment", {
      type: "String",
      allowedPattern: ".+",
      default: "int",
      description: "Your environment name. Change to a unique name only if deploy the stack multiple times in the same region and account."
    });
    const gitHubUserName = new CfnParameter(this, "gitHubUserName", {
      type: "String",
      allowedPattern: ".+",
      description: "Your github user name (see pre-deployment steps)"
    });

    const githubtoken = new CfnParameter(this, "githubtoken", {
      type: "String",
      allowedPattern: ".+",
      description: "Your github Personal access tokens allowing access to the forked repository (see pre-deployment steps)"
    });

    const artifactBucket = new Bucket(this, "iotOnboardingArtifacts", {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })

    //TODO: provide a more granular access to the code build pipeline
    const buildProjectRole = new Role(this, 'buildRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")]
    })

    const infraBuild = new codebuild.PipelineProject(this, 'infraBuilProject', {
      projectName: "code-build-iot-onboarding-infra-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            "runtime-versions": {
              nodejs: 16
            },
            commands: [
              'echo "CodeBuild is running in $AWS_REGION" && aws configure set region $AWS_REGION',
              'npm install -g aws-cdk@1.139.0',
              'npm -g install typescript@4.2.2',
              'cdk --version',
              'cd iot-onboarding-infra',
              'npm install'
            ]
          },
          build: {
            commands: [
              'echo "Build and Deploy Infrastructure"',
              'pwd && sh deploy.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName + " " + rootMqttTopic.valueAsString + " " + contactEmail.valueAsString
            ],
          },
        },
        artifacts: {
          "discard-path": "yes",
          files: [
            'iot-onboarding-infra/infra-config-' + envNameVal.valueAsString + '.json',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const lambdaBuild = new codebuild.PipelineProject(this, 'lambdaBuilProject', {
      projectName: "code-build-iot-onboarding-lambda-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            "runtime-versions": {
              golang: 1.13
            }
          },
          build: {
            commands: [
              'echo "Build and Deploy lambda Function"',
              'cd iot-onboarding-service',
              'pwd && sh lbuild.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName
            ],
          },
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const glueEtlBuild = new codebuild.PipelineProject(this, 'glueETLBuilProject', {
      projectName: "code-build-iot-onboarding-etl-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Uploading ETK script to s3"',
              'cd iot-onboarding-data-processing',
              'pwd && sh ./deploy.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName
            ],
          },
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const siteWiseBuild = new codebuild.PipelineProject(this, 'siteWiseBuildProject', {
      projectName: "code-build-iot-onboarding-sitewise-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Building sitewise Assets model and project"',
              'cd iot-onboarding-sitewise',
              'pwd && sh ./sitewise.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName + " " + contactEmail.valueAsString
            ],
          },
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const quicksightBuild = new codebuild.PipelineProject(this, 'quicksightBuildProject', {
      projectName: "code-build-iot-onboarding-quicksight-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Building Quicksight Dashboard"',
              'cd iot-onboarding-quicksight',
              'pwd && sh ./create-dashboard.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName + " " + quickSightAdminUserName.valueAsString + " " + sourceTemplateArn.valueAsString + " " + quickSightAdminUserRegion.valueAsString
            ],
          },
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const onboardingTest = new codebuild.PipelineProject(this, 'testProject', {
      projectName: "code-build-iot-onboarding-test-" + envNameVal.valueAsString,
      role: buildProjectRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            "runtime-versions": {
              nodejs: 10
            },
            commands: [
              "yum -y install epel-release",
              "yum -y install mosquitto",
              "npm install -g newman@5.2.2"
            ]
          },
          build: {
            commands: [
              'echo "Testing Deployed on boarding service"',
              'cd e2e',
              'pwd && sh ./test.sh ' + envNameVal.valueAsString + " " + artifactBucket.bucketName
            ],
          },
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });



    //Output Artifacts
    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutputLambda = new codepipeline.Artifact('CdkBuildOutputLambda');
    const cdkBuildOutputETL = new codepipeline.Artifact('CdkBuildOutputETL');
    const cdkBuildOutputInfra = new codepipeline.Artifact('CdkBuildOutputInfra');
    const cdkBuildOutputTest = new codepipeline.Artifact('CdkBuildOutputTest');
    const siteWiseOutput = new codepipeline.Artifact('siteWiseOutput');
    const quickSightOutput = new codepipeline.Artifact('quickSightOutput');


    const sourceBucker = Bucket.fromBucketAttributes(this, 'iotQuickstartSourceBucket', {
      bucketName: "aws-quickstart-" + region
    });

    let stages: codepipeline.StageProps[] = []
    //Source  stage
    stages.push({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          repo: gitHubRepo,
          oauthToken: SecretValue.plainText(githubtoken.valueAsString),
          branch: "main",
          owner: gitHubUserName.valueAsString,
          output: sourceOutput,
        }),
      ],
    })
    //Build  stage
    stages.push({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'uploadELTScript',
          project: glueEtlBuild,
          input: sourceOutput,
          runOrder: 1,
          outputs: [cdkBuildOutputETL],
        }),
        new codepipeline_actions.CodeBuildAction({
          actionName: 'buildLambdaCode',
          project: lambdaBuild,
          input: sourceOutput,
          runOrder: 2,
          outputs: [cdkBuildOutputLambda],
        }),
        new codepipeline_actions.CodeBuildAction({
          actionName: 'deployInfra',
          project: infraBuild,
          input: sourceOutput,
          runOrder: 3,
          outputs: [cdkBuildOutputInfra],
        }),
      ],
    })
    //Test Stage
    stages.push({
      stageName: 'Test',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'testOnboardingService',
          project: onboardingTest,
          input: sourceOutput,
          outputs: [cdkBuildOutputTest],
        }),
      ],
    })
    //Deploy Stages
    let deployStage: codepipeline.StageProps = {
      stageName: 'Deploy',
      actions: [],
    }
    if (deployStage.actions) {
      deployStage.actions.push(new codepipeline_actions.S3DeployAction({
        actionName: "deployInfraConfigToS3",
        bucket: artifactBucket,
        runOrder: 1,
        input: cdkBuildOutputInfra
      }))
      //QuickSight dashboard is conditionally added if a Quicksight admin user is provided
      if (quickSightAdminUserName.valueAsString) {
        deployStage.actions.push(new codepipeline_actions.CodeBuildAction({
          actionName: 'setupQuicksight',
          project: quicksightBuild,
          input: sourceOutput,
          runOrder: 2,
          outputs: [quickSightOutput],
        }))
      }
      deployStage.actions.push(new codepipeline_actions.CodeBuildAction({
        actionName: 'setupSitewise',
        project: siteWiseBuild,
        input: sourceOutput,
        runOrder: 2,
        outputs: [siteWiseOutput],
      }))
    }
    stages.push(deployStage)

    //creating a dedicated bucker to avoid erroor with Key generated with identical id
    const pipelineArtifactBucket = new Bucket(this, "iotOnboardingPipelineArtifacts", {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true
    })

    new codepipeline.Pipeline(this, 'IotOnboardingPipeline', {
      pipelineName: "code-pipeline-iot-onboarding-" + envNameVal.valueAsString,
      stages: stages,
      artifactBucket: pipelineArtifactBucket
    });

  }

}








