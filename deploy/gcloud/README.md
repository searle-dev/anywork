# Google Cloud Deployment (Phase 2)

## Prerequisites

- Google Cloud project with billing enabled
- `gcloud` CLI installed and authenticated
- Docker installed locally

## Architecture

```
Cloud Run (server)  ──▶  Cloud Run (worker)  ──▶  Filestore (NFS)
        │                                              ▲
   Cloud SQL (PostgreSQL)                              │
                                          VPC Serverless Connector
```

## Setup Steps

### 1. Enable APIs
```bash
gcloud services enable \
  run.googleapis.com \
  file.googleapis.com \
  sqladmin.googleapis.com \
  vpcaccess.googleapis.com \
  artifactregistry.googleapis.com
```

### 2. Create Filestore Instance
```bash
gcloud filestore instances create anywork-fs \
  --zone=us-central1-a \
  --tier=BASIC_HDD \
  --file-share=name=anywork_share,capacity=1TB \
  --network=name=default
```

### 3. Create VPC Connector
```bash
gcloud compute networks vpc-access connectors create anywork-vpc \
  --region=us-central1 \
  --range=10.8.0.0/28
```

### 4. Build & Push Images
```bash
# Build images
docker build -t gcr.io/$PROJECT/anywork-server ./server
docker build -t gcr.io/$PROJECT/anywork-worker ./worker
docker build -t gcr.io/$PROJECT/anywork-web ./web

# Push
docker push gcr.io/$PROJECT/anywork-server
docker push gcr.io/$PROJECT/anywork-worker
docker push gcr.io/$PROJECT/anywork-web
```

### 5. Deploy Cloud Run Services

See `cloudrun-server.yaml` and `cloudrun-worker.yaml` for service definitions.

## Cost Estimate

For 1000 DAU with ~3 sessions/day (5 min each):

| Service | Monthly Cost (USD) |
|---------|-------------------|
| Cloud Run (server) | ~$15 |
| Cloud Run (workers) | ~$50 |
| Filestore (1TB HDD) | ~$200 |
| Cloud SQL (small) | ~$30 |
| **Total** | **~$295/month** |
