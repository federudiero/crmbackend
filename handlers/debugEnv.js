// api/debugEnv.js
export default function handler(req, res) {
  res.json({
    tokenSet: !!process.env.META_WA_TOKEN,
    phoneIdSet: !!process.env.META_WA_PHONE_ID,
    verifySet: !!process.env.META_WA_VERIFY_TOKEN,
  });
}
