// AWS PDF Compression System - script.js (starter replacement)
// UPDATE THESE VALUES IF THEY CHANGE
const REGION="us-east-2";
const IDENTITY_POOL_ID="us-east-2:0b8e0783-f3a2-40ba-93da-f970ead637b2";
const INPUT_BUCKET="pdf-compressor-input-868942372673";
const OUTPUT_BUCKET="pdf-compressor-output-868942372673";

// NOTE:
// This is a scaffold for the updated frontend.
// Replace your existing script.js with this file and extend polling logic as needed.

AWS.config.region=REGION;
AWS.config.credentials=new AWS.CognitoIdentityCredentials({
  IdentityPoolId:IDENTITY_POOL_ID
});

const s3=new AWS.S3({apiVersion:"2006-03-01"});

const fileInput=document.getElementById("pdfFile");
const uploadBtn=document.getElementById("uploadBtn");
const downloadBtn=document.getElementById("downloadBtn");
const statusText=document.getElementById("statusText");
const progressFill=document.getElementById("progressFill");
const progressPercent=document.getElementById("progressPercent");
const fileName=document.getElementById("fileName");
const fileSize=document.getElementById("fileSize");

let uploadedKey=null;

fileInput.addEventListener("change",()=>{
 const f=fileInput.files[0];
 if(!f)return;
 fileName.textContent=f.name;
 fileSize.textContent=(f.size/1024).toFixed(1)+" KB";
});

uploadBtn.addEventListener("click",()=>{
 const f=fileInput.files[0];
 if(!f){alert("Select a PDF");return;}
 AWS.config.credentials.get(err=>{
   if(err){console.error(err);statusText.textContent="Credential error";return;}
   uploadedKey=f.name;
   const task=s3.upload({
      Bucket:INPUT_BUCKET,
      Key:uploadedKey,
      Body:f,
      ContentType:"application/pdf"
   });
   task.on("httpUploadProgress",e=>{
      const p=Math.round(e.loaded/e.total*100);
      progressFill.style.width=p+"%";
      progressPercent.textContent=p+"%";
   });
   task.send((err)=>{
      if(err){
         console.error(err);
         statusText.textContent="Upload failed";
         return;
      }
      statusText.textContent = "Upload successful. Waiting for Lambda...";

AWS.config.credentials.refresh(function(err){

    if(err){
        console.error(err);
        statusText.textContent = "Credential refresh failed";
        return;
    }

    pollOutput();

});
   });
 });
});

function pollOutput() {

    const target = "compressed-" + uploadedKey;

    const outputS3 = new AWS.S3({
        region: REGION
    });

    const timer = setInterval(() => {

        console.log("Checking:", target);

        outputS3.headObject({

            Bucket: OUTPUT_BUCKET,

            Key: target

        }, (err) => {

            if (err) {

                console.error("Polling Error:", err);

                statusText.textContent = err.code;

                return;

            }

            clearInterval(timer);

            statusText.textContent = "Compression Complete";

            downloadBtn.disabled = false;

            downloadBtn.onclick = () => {

                const url = outputS3.getSignedUrl("getObject", {

                    Bucket: OUTPUT_BUCKET,

                    Key: target,

                    Expires: 300

                });

                window.open(url, "_blank");

            };

        });

    }, 5000);

}
