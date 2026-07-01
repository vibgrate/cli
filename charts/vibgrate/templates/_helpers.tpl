{{/* Expand the name of the chart. */}}
{{- define "vibgrate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "vibgrate.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "vibgrate.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "vibgrate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: scanner
{{- end -}}

{{/* Selector labels. */}}
{{- define "vibgrate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vibgrate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Image reference; tag falls back to the chart appVersion. */}}
{{- define "vibgrate.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/* ServiceAccount name. */}}
{{- define "vibgrate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "vibgrate.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding the DSN. */}}
{{- define "vibgrate.dsnSecretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "vibgrate.fullname" . -}}
{{- end -}}
{{- end -}}

{{/* Validate that a DSN source is configured. */}}
{{- define "vibgrate.validateDsn" -}}
{{- if and (not .Values.dsn) (not .Values.existingSecret) -}}
{{- fail "A workspace DSN is required: set `dsn` or point `existingSecret` at a Secret containing it." -}}
{{- end -}}
{{- end -}}

{{/*
Pod spec shared by the CronJob and the optional one-off Job. Rendered with the
root context. Indent the include at the `spec:` level of a pod template.
*/}}
{{- define "vibgrate.podSpec" -}}
restartPolicy: Never
serviceAccountName: {{ include "vibgrate.serviceAccountName" . }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- if .Values.repository.url }}
initContainers:
  - name: clone
    image: alpine/git:latest
    securityContext:
      {{- toYaml .Values.securityContext | nindent 6 }}
    workingDir: /work
    command:
      - /bin/sh
      - -c
      - |
        set -eu
        URL="{{ .Values.repository.url }}"
        {{- if .Values.repository.tokenSecret }}
        URL=$(printf '%s' "$URL" | sed "s#https://#https://${GIT_TOKEN}@#")
        {{- end }}
        git clone --depth 1 {{ with .Values.repository.ref }}--branch {{ . }} {{ end }}"$URL" /work
    {{- if .Values.repository.tokenSecret }}
    env:
      - name: GIT_TOKEN
        valueFrom:
          secretKeyRef:
            name: {{ .Values.repository.tokenSecret }}
            key: {{ .Values.repository.tokenSecretKey }}
    {{- end }}
    volumeMounts:
      - name: work
        mountPath: /work
      {{- with .Values.extraVolumeMounts }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
{{- end }}
containers:
  - name: scanner
    image: {{ include "vibgrate.image" . | quote }}
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    securityContext:
      {{- toYaml .Values.securityContext | nindent 6 }}
    args:
      {{- toYaml .Values.scanArgs | nindent 6 }}
    env:
      - name: VIBGRATE_DSN
        valueFrom:
          secretKeyRef:
            name: {{ include "vibgrate.dsnSecretName" . }}
            key: {{ .Values.existingSecretKey }}
    volumeMounts:
      - name: work
        mountPath: /work
      - name: tmp
        mountPath: /tmp
      {{- with .Values.extraVolumeMounts }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    resources:
      {{- toYaml .Values.resources | nindent 6 }}
volumes:
  - name: work
    emptyDir: {}
  - name: tmp
    emptyDir: {}
  {{- with .Values.extraVolumes }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
