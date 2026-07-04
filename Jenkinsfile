pipeline {
  agent none

  environment {
    SERVICE_NAME = 'ekoru-transactions'
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
        sh '''
          cp /opt/ekoru/secrets/ekoru-transactions/.env.staging ${WORKSPACE}/.env.staging
          docker compose -f compose.staging.yml build --no-cache
          docker compose -f compose.staging.yml up -d --force-recreate
          docker image prune -f
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
        sh '''
          cp /opt/ekoru/secrets/ekoru-transactions/.env.prod ${WORKSPACE}/.env.prod
          docker compose -f compose.prod.yml build --no-cache
          docker compose -f compose.prod.yml up -d --force-recreate
          docker image prune -f
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
