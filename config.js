window.CONFERENCE_HELPER_CONFIG = Object.freeze({
    backendUrl: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? 'http://127.0.0.1:8080'
        : 'https://translator-backend-258115702573.asia-northeast3.run.app',
    firebase: {
        apiKey: 'AIzaSyBkR6Tu6dDyAArQf2mrs7Tb7h97pfjjCFs',
        authDomain: 'internation-conference-helper.firebaseapp.com',
        projectId: 'internation-conference-helper',
        storageBucket: 'internation-conference-helper.firebasestorage.app',
        messagingSenderId: '258115702573',
        appId: '1:258115702573:web:96731227a9dae2445e4da4'
    }
});
