# Define the URL where Label Studio is accessible
LABEL_STUDIO_URL = "http://localhost:8080/"

# API key can be either your PAT or legacy access token
LABEL_STUDIO_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3MDA0NzkzOSwiaWF0IjoxNzYyODQ3OTM5LCJqdGkiOiIyNmJmMjMzN2UzM2U0MjFjYmFhNDJhNzczMDc5MzQyMiIsInVzZXJfaWQiOiIyIn0.cFmqvVpsDEhP3ot8oV-PGE_qzFcRvnkrz6Qa2Tm21XA"

# Import the SDK and the client module
from label_studio_sdk import LabelStudio

client = LabelStudio(
    base_url=LABEL_STUDIO_URL,
    api_key=LABEL_STUDIO_API_KEY,
)
response = client.projects.list()
for item in response:
    print(item.id, item.title)

    client.projects.delete(
        id=item.id,
    )