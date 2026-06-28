pipeline {
  agent any

  environment {
    SERVICE_NAME    = 'ekoru-transactions'
    SERVICE_PORT    = '4007'
    ACR_NAME        = credentials('acr-name')
    ACR_LOGIN_SERVER = "${ACR_NAME}.azurecr.io"
    IMAGE_TAG       = "${ACR_LOGIN_SERVER}/${SERVICE_NAME}:${GIT_COMMIT}"
  }

  stages {

    stage('Skip CI check') {
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
      steps {
        sh 'npm ci'
      }
    }

    stage('Prisma Generate') {
      steps {
        sh 'npm run prisma:gen'
      }
    }

    stage('Build') {
      steps {
        sh 'npm run build'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test -- --passWithNoTests'
      }
    }

    stage('Docker Build & Push') {
      when { branch 'main' }
      steps {
        withCredentials([
          usernamePassword(
            credentialsId: 'azure-acr-sp',
            usernameVariable: 'ACR_CLIENT_ID',
            passwordVariable: 'ACR_CLIENT_SECRET'
          )
        ]) {
          sh """
            docker login ${ACR_LOGIN_SERVER} \
              --username ${ACR_CLIENT_ID} \
              --password ${ACR_CLIENT_SECRET}
            docker build -t ${IMAGE_TAG} .
            docker push ${IMAGE_TAG}
            docker rmi ${IMAGE_TAG} || true
          """
        }
      }
    }

    stage('Deploy to Ionos') {
      when { branch 'main' }
      steps {
        withCredentials([
          sshUserPrivateKey(credentialsId: 'ionos-ssh-key', keyFileVariable: 'SSH_KEY'),
          string(credentialsId: 'ionos-host', variable: 'IONOS_HOST'),
          string(credentialsId: 'ionos-user', variable: 'IONOS_USER'),
          usernamePassword(
            credentialsId: 'azure-acr-sp',
            usernameVariable: 'ACR_CLIENT_ID',
            passwordVariable: 'ACR_CLIENT_SECRET'
          )
        ]) {
          sh """
            ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no ${IONOS_USER}@${IONOS_HOST} '
              docker login ${ACR_LOGIN_SERVER} \
                --username ${ACR_CLIENT_ID} \
                --password ${ACR_CLIENT_SECRET}
              docker pull ${IMAGE_TAG}
              docker stop ${SERVICE_NAME} || true
              docker rm   ${SERVICE_NAME} || true
              docker run -d \
                --name ${SERVICE_NAME} \
                --restart unless-stopped \
                -p ${SERVICE_PORT}:${SERVICE_PORT} \
                --env-file /etc/ekoru/${SERVICE_NAME}.env \
                ${IMAGE_TAG}
            '
          """
        }
      }
    }

  }

  post {
    failure {
      echo "Pipeline failed for ${SERVICE_NAME}"
    }
    success {
      echo "Deployed ${SERVICE_NAME}:${GIT_COMMIT} successfully"
    }
  }
}
