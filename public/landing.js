(async()=>{const s=await Athena.me();Athena.authArea(s.user);const p=new URLSearchParams(location.search);if(p.get('googleError')) Athena.toast(p.get('googleError'));})();
