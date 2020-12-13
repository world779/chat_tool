const express = require("express");
const app = express();
const { pool } = require("./dbConfig");
const bcrypt = require("bcrypt");
const session = require("express-session");
const flash = require("express-flash");
const passport = require("passport");

const initializePassport = require("./passportConfig");

initializePassport(passport);

const http = require("http").Server(app);
const io = require("socket.io")(http);
const crypto = require("crypto");
const { report } = require("process");
const DOCUMENT_ROOT = __dirname + "/public";
//デプロイ時は変更の上環境変数にして削除
const SECRET_TOKEN = "abcdefghijklmn12345";

const MEMBER = {};
const TOKENS = {};
let MEMBER_COUNT = 1;

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: "secret",

    resave: false,

    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use(flash());

app.get("/", (req, res) => {
  res.sendFile(DOCUMENT_ROOT + "/index.html");
});

app.get("/users/register", checkAuthenticated, (req, res) => {
  res.render("register");
});

app.get("/users/login", checkAuthenticated, (req, res) => {
  res.render("login");
});

app.get("/users/dashboard", checkNotAutheticated, (req, res) => {
  res.render("dashboard", { user: req.user.name });
});

app.get("/users/logout", (req, res) => {
  req.logout();
  req.flash("success_msg", "ログアウトを完了しました");
  res.redirect("/users/login");
});

app.post("/users/register", async (req, res) => {
  let { name, email, password, password2 } = req.body;

  console.log({
    name,
    email,
    password,
    password2,
  });

  let errors = [];

  if (!name || !email || !password || !password2) {
    errors.push({ message: "すべての項目を入力してください" });
  }

  if (password.length < 6) {
    errors.push({ message: "パスワードは最低6文字にしてください" });
  }

  if (password != password2) {
    errors.push({ message: "パスワードが一致しません" });
  }

  if (errors.length > 0) {
    res.render("register", { errors });
  } else {
    let hashedPassword = await bcrypt.hash(password, 10);
    console.log(hashedPassword);

    pool.query(
      `SELECT * FROM users
        WHERE email = $1`,
      [email],
      (err, results) => {
        if (err) {
          console.log(err);
        }
        console.log(results.rows);

        if (results.rows.length > 0) {
          errors.push({ message: "このメールアドレスは既に登録されています" });
          res.render("register", { errors });
        } else {
          pool.query(
            `INSERT INTO users (name, email, password)
            VALUES ($1, $2, $3)
            RETURNING id, password`,
            [name, email, hashedPassword],
            (err, results) => {
              if (err) {
                throw err;
              }
              console.log(results.rows);
              req.flash(
                "success_msg",
                "登録が完了しました。ログインしてください。"
              );
              res.redirect("/users/login");
            }
          );
        }
      }
    );
  }
});

app.post(
  "/users/login",
  passport.authenticate("local", {
    successRedirect: "/users/dashboard",
    failureRedirect: "/users/login",
    failureFlash: true,
  })
);

function checkAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return res.redirect("/users/dashboard");
  }
  next();
}

function checkNotAutheticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect("/users/login");
}

app.use(express.static(__dirname + "/public"));
app.use("/animejs", express.static(__dirname + "/node_modules/animejs/lib/"));

// S04. connectionイベントを受信する
io.on("connection", function (socket) {
  (() => {
    // トークンを作成
    const token = crypto
      .createHash("sha1")
      .update(SECRET_TOKEN + socket.id)
      .digest("hex");

    // ユーザーリストに追加
    MEMBER[socket.id] = {
      name: null,
      room: null,
      count: MEMBER_COUNT,
      x: 0,
      y: 0,
    };
    TOKENS[socket.id] = token;
    MEMBER_COUNT++;

    // 本人にトークンを送付
    io.to(socket.id).emit("token", {
      token: token,
      id: MEMBER[socket.id].count,
    });
    console.log(socket.id);
  })();

  // ルームに入室されたらsocketをroomにjoinさせてメンバーリストにもそれを反映
  socket.on("c2s_join", function (data) {
    if (data.token == TOKENS[socket.id]) {
      io.to(socket.id).emit("initial_data", { data: MEMBER });
      console.log(MEMBER);
      MEMBER[socket.id].name = data.name;
      MEMBER[socket.id].room = data.room;
      socket.join(data.room);
      var msg = MEMBER[socket.id].name + "さんが入室しました。";
      io.to(MEMBER[socket.id].room).emit("s2c_join", {
        id: MEMBER[socket.id].count,
        name: MEMBER[socket.id].name,
        msg: msg,
      });
    }
  });
  // メッセージがきたら名前とメッセージをくっつけて送り返す
  socket.on("c2s_msg", function (data) {
    // S06. server_to_clientイベント・データを送信する
    var minDist = data.dist;
    if (TOKENS[socket.id] == data.token) {
      var sender = MEMBER[socket.id];
      io.to(sender.room).emit("s2c_dist", { id: sender.count, dist: minDist });
      var msg = sender.name + ": " + data.msg;
      Object.keys(MEMBER).forEach(function (key) {
        var member = MEMBER[key];
        var dist = calcDist(member.x, member.y, sender.x, sender.y);
        if (dist < minDist) io.to(key).emit("s2c_msg", { msg: msg });
      }, MEMBER);
    }
  });

  socket.on("c2s_move", function (data) {
    if (TOKENS[socket.id] == data.token) {
      MEMBER[socket.id].x = data.x;
      MEMBER[socket.id].y = data.y;
      io.to(MEMBER[socket.id].room).emit("s2c_move", {
        id: MEMBER[socket.id].count,
        x: MEMBER[socket.id].x,
        y: MEMBER[socket.id].y,
      });
    }
  });

  // S09. dicconnectイベントを受信し、退出メッセージを送信する
  socket.on("disconnect", function () {
    if (MEMBER[socket.id].name == null) {
      console.log("未入室のまま、どこかへ去っていきました。");
    } else {
      var msg = MEMBER[socket.id].name + "さんが退出しました。";
      io.to(MEMBER[socket.id].room).emit("s2c_leave", {
        id: MEMBER[socket.id].count,
        msg: msg,
      });
    }
    delete MEMBER[socket.id];
  });
  socket.on("user-reconnected", function (data) {
    console.log(data + "recconected");
  });
});

function calcDist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
}

http.listen(3000, function () {
  console.log("listening on *:3000");
});
