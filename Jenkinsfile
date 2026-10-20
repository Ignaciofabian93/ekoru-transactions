// Writes this service's env file for one environment from Infisical (INF-14). The CLI runs
// as a one-off container on the infisical-clients network, so nothing is installed in
// Jenkins. The folder in Infisical is named after SERVICE_NAME. If the file lacks the key
// the service always has, the deploy stops before anything is built.
def exportEnvFromInfisical(String environment, String envFile, String requiredKey) {
  withCredentials([
    string(credentialsId: 'infisical-client-id', variable: 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID'),
    string(credentialsId: 'infisical-client-secret', variable: 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET'),
    string(credentialsId: 'infisical-project-id', variable: 'INFISICAL_PROJECT_ID')
  ]) {
    withEnv(["ENV_SLUG=${environment}", "ENV_FILE=${envFile}", "REQUIRED_KEY=${requiredKey}"]) {
      sh '''
        set +x  # keeps the access token out of the build log
        RUN="docker run --rm --network infisical-clients -e INFISICAL_DOMAIN=http://infisical:8080"
        IMAGE=infisical/cli:0.44.1
        INFISICAL_TOKEN=$($RUN -e INFISICAL_UNIVERSAL_AUTH_CLIENT_ID -e INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET \
          $IMAGE login --method=universal-auth --silent --plain)
        export INFISICAL_TOKEN
        # --expand=false: values are written exactly as stored, so a "$" in a password stays.
        $RUN -e INFISICAL_TOKEN -e INFISICAL_PROJECT_ID $IMAGE \
          sm export --env="$ENV_SLUG" --path="/$SERVICE_NAME" --format=dotenv --expand=false --silent \
          > "$ENV_FILE"
        grep -q "^$REQUIRED_KEY=" "$ENV_FILE" \
          || { echo "The Infisical export for $SERVICE_NAME ($ENV_SLUG) has no $REQUIRED_KEY. Not deploying."; exit 1; }
      '''
    }
  }
}

pipeline {
  agent none

  environment {
    SERVICE_NAME = 'ekoru-transactions'
  }

  // Build records and logs are kept for the last 20 runs only (INF-15).
  options {
    buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '5'))
  }

  stages {

    // Prevents the version-bump commit from re-triggering the full pipeline
    stage('Skip CI check') {
      agent any
      steps {
        script {
          def msg = sh(script: 'git log -1 --pretty=%B', returnStdout: true).trim()
          if (msg.contains('[skip ci]')) {
            currentBuild.result = 'NOT_BUILT'
            error('Version bump commit — skipping pipeline.')
          }
        }
      }
    }

    stage('Install') {
      agent {
        docker {
          image 'node:22-alpine'
          args '-u root'
        }
      }
      steps {
        sh 'npm ci'
      }
    }

    stage('Prisma Generate') {
      agent {
        docker {
          image 'node:22-alpine'
          args '-u root'
        }
      }
      steps {
        sh 'npm run prisma:gen'
      }
    }

    stage('Build') {
      agent {
        docker {
          image 'node:22-alpine'
          args '-u root'
        }
      }
      steps {
        sh 'npm run build'
      }
    }

    stage('Test') {
      agent {
        docker {
          image 'node:22-alpine'
          args '-u root'
        }
      }
      steps {
        sh 'npm test -- --passWithNoTests'
      }
    }

    // ── Staging flow ──────────────────────────────────────────────────────────
    // The secret env-file carries DATABASE_URL, INTERNAL_SERVICE_SECRET,
    // MARKETPLACE_URL/STORES_URL/GATEWAY_BASE_URL and REDIS_PASSWORD. compose
    // brings up both the subgraph and its Redis on ekoru-staging-network.

    stage('Deploy Staging') {
      agent any
      when { branch 'main' }
      steps {
        script { exportEnvFromInfisical('staging', '.env.staging', 'DATABASE_URL') }
        sh '''
          docker compose -f compose.staging.yml build --no-cache
          docker compose -f compose.staging.yml up -d --force-recreate
          docker image prune -f
          # --no-cache builds never reuse the build cache, but it still grows on
          # every deploy until the disk fills (INF-15). Keep the last day only.
          docker builder prune -f --filter until=24h
        '''
        sshagent(['github-deploy-key-transactions']) {
          sh '''
            git remote set-url origin "$(git remote get-url origin | sed 's|https://github.com/|git@github.com:|')"
            VERSION=$(grep -m1 '"version"' package.json | awk -F'"' '{print $4}')
            git tag -f "staging/v${VERSION}"
            git push -f origin "staging/v${VERSION}"
          '''
        }
      }
    }

    stage('Confirm E2E OK') {
      agent none
      when { branch 'main' }
      steps {
        timeout(time: 24, unit: 'HOURS') {
          input message: "Staging deployed for ${SERVICE_NAME}. E2E tests passed?",
                ok: 'Yes, deploy to production'
        }
      }
    }

    // ── Production deploy ─────────────────────────────────────────────────────

    stage('Deploy Production') {
      agent any
      when { branch 'main' }
      steps {
        script { exportEnvFromInfisical('prod', '.env.prod', 'DATABASE_URL') }
        sh '''
          docker compose -f compose.prod.yml build --no-cache
          docker compose -f compose.prod.yml up -d --force-recreate
          docker image prune -f
          # --no-cache builds never reuse the build cache, but it still grows on
          # every deploy until the disk fills (INF-15). Keep the last day only.
          docker builder prune -f --filter until=24h
        '''
        sshagent(['github-deploy-key-transactions']) {
          sh '''
            git remote set-url origin "$(git remote get-url origin | sed 's|https://github.com/|git@github.com:|')"
            VERSION=$(grep -m1 '"version"' package.json | awk -F'"' '{print $4}')
            git tag -f "prod/v${VERSION}"
            git push -f origin "prod/v${VERSION}"
          '''
        }
      }
    }

  }

  post {
      failure {
          echo "Pipeline failed for ${SERVICE_NAME} on branch ${env.BRANCH_NAME}"
      }
      success {
          echo "Pipeline completed for ${SERVICE_NAME} on ${env.BRANCH_NAME}"
      }
  }
}
