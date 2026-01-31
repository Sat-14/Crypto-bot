const jwt = require('jsonwebtoken');

module.exports = {
    getAuth(req, res, jwtSecret){
        const authCookie = req.getHeader("cookie");
        const token = authCookie?.split(";").find(cookie => cookie.trim().startsWith("auth="))?.split("=")[1];

        if (!token) {
            res.writeStatus("401 Unauthorized").end();
            return;
        }

        const decoded = jwt.verify(token, jwtSecret);

        if (!decoded || !decoded.id) {
            res.writeStatus("401 Unauthorized").end();
            return;
        }

        return decoded.id;
    }
}